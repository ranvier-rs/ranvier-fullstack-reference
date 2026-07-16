use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use ranvier_core::prelude::*;
use ranvier_http::prelude::*;
use ranvier_runtime::Axon;
use serde::{Deserialize, Serialize};

use crate::domain::{
    AuthorizationFault, EvidenceSnapshot, OrderAuthorizationRequest, OrderAuthorizationResult,
    OrderResources, authorization_workflow,
};
use crate::store::PgDecisionStore;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuthorizationEnvelope {
    Ok { result: OrderAuthorizationResult },
    Fault { fault: AuthorizationFault },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationHttpResponse {
    status: u16,
    body: AuthorizationEnvelope,
}

impl AuthorizationHttpResponse {
    fn success(result: OrderAuthorizationResult) -> Self {
        Self {
            status: http::StatusCode::OK.as_u16(),
            body: AuthorizationEnvelope::Ok { result },
        }
    }

    fn fault(fault: AuthorizationFault) -> Self {
        let status = match fault.code.as_str() {
            "order_id_invalid"
            | "idempotency_key_invalid"
            | "customer_id_invalid"
            | "payment_reference_invalid"
            | "items_invalid"
            | "amount_invalid"
            | "currency_invalid" => http::StatusCode::BAD_REQUEST,
            "idempotency_key_conflict" | "decision_reconciliation_conflict" => {
                http::StatusCode::CONFLICT
            }
            "inventory_out_of_stock" | "payment_declined" => http::StatusCode::UNPROCESSABLE_ENTITY,
            _ => http::StatusCode::SERVICE_UNAVAILABLE,
        };
        Self {
            status: status.as_u16(),
            body: AuthorizationEnvelope::Fault { fault },
        }
    }
}

impl IntoResponse for AuthorizationHttpResponse {
    fn into_response(self) -> HttpResponse {
        let mut response = Json(self.body).into_response();
        *response.status_mut() = http::StatusCode::from_u16(self.status)
            .unwrap_or(http::StatusCode::INTERNAL_SERVER_ERROR);
        response
    }
}

#[derive(Clone, Copy)]
struct NativeAuthorize;

#[async_trait]
impl Transition<OrderAuthorizationRequest, AuthorizationHttpResponse> for NativeAuthorize {
    type Error = String;
    type Resources = OrderResources;

    fn label(&self) -> String {
        "NativeHttpAuthorizationAdapter".to_string()
    }

    fn description(&self) -> Option<String> {
        Some("Map the shared domain Outcome to a stable native HTTP envelope".to_string())
    }

    async fn run(
        &self,
        request: OrderAuthorizationRequest,
        resources: &Self::Resources,
        bus: &mut Bus,
    ) -> Outcome<AuthorizationHttpResponse, Self::Error> {
        let fallback_request = request.clone();
        let response = match authorization_workflow()
            .execute(request, resources, bus)
            .await
        {
            Outcome::Next(result) => AuthorizationHttpResponse::success(result),
            Outcome::Fault(fault) => AuthorizationHttpResponse::fault(fault),
            Outcome::Branch(_, _) | Outcome::Jump(_, _) | Outcome::Emit(_, _) => {
                AuthorizationHttpResponse::fault(AuthorizationFault {
                    code: "unexpected_domain_control_flow".to_string(),
                    failed_step: "NativeHttpAuthorizationAdapter".to_string(),
                    message: "domain workflow returned unsupported non-terminal control flow"
                        .to_string(),
                    order_id: fallback_request.order_id,
                    idempotency_key: fallback_request.idempotency_key,
                    retryable: false,
                    operator_action_required: true,
                    compensations: Vec::new(),
                })
            }
        };
        Outcome::Next(response)
    }
}

#[derive(Clone, Copy)]
struct Health;

#[async_trait]
impl Transition<(), serde_json::Value> for Health {
    type Error = String;
    type Resources = OrderResources;

    async fn run(
        &self,
        _input: (),
        _resources: &Self::Resources,
        _bus: &mut Bus,
    ) -> Outcome<serde_json::Value, Self::Error> {
        Outcome::Next(serde_json::json!({
            "status": "ok",
            "service": "order-authorization-native",
            "ranvier_candidate": "0.51.0-m420.1"
        }))
    }
}

#[derive(Clone, Copy)]
struct ReadEvidence;

#[async_trait]
impl Transition<(), EvidenceSnapshot> for ReadEvidence {
    type Error = AuthorizationFault;
    type Resources = OrderResources;

    fn label(&self) -> String {
        "ReadRedactedEvidence".to_string()
    }

    async fn run(
        &self,
        _input: (),
        resources: &Self::Resources,
        _bus: &mut Bus,
    ) -> Outcome<EvidenceSnapshot, Self::Error> {
        match resources.evidence().await {
            Ok(evidence) => Outcome::Next(evidence),
            Err(fault) => Outcome::Fault(fault),
        }
    }
}

pub fn build_native_ingress() -> HttpIngress<OrderResources> {
    let authorize =
        Axon::<OrderAuthorizationRequest, OrderAuthorizationRequest, String, OrderResources>::new(
            "native-http-order-authorization",
        )
        .then(NativeAuthorize);
    let health = Axon::<(), (), String, OrderResources>::new("native-health").then(Health);
    let evidence = Axon::<(), (), AuthorizationFault, OrderResources>::new("native-evidence")
        .then(ReadEvidence);

    Ranvier::http::<OrderResources>()
        .post_typed("/api/order-authorizations", authorize)
        .get_json_out("/api/order-authorizations/evidence", evidence)
        .get_json_out("/api/health", health)
}

fn production_config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("RANVIER_CONFIG") {
        return PathBuf::from(path);
    }
    let repository_path = Path::new("backend/ranvier.toml");
    if repository_path.is_file() {
        repository_path.to_path_buf()
    } else {
        PathBuf::from("ranvier.toml")
    }
}

async fn connect_postgres(database_url: &str) -> Result<sqlx::PgPool, std::io::Error> {
    for attempt in 1..=10 {
        match sqlx::PgPool::connect(database_url).await {
            Ok(pool) => return Ok(pool),
            Err(_) if attempt < 10 => {
                tracing::warn!(attempt, "PostgreSQL connection unavailable; retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(_) => break,
        }
    }
    Err(std::io::Error::other(
        "PostgreSQL connection failed after bounded retries",
    ))
}

pub async fn run_native_from_env() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let resolved =
        ResolvedRuntimeConfig::from_file_for(production_config_path(), RuntimeProfile::Production)
            .map_err(|_| std::io::Error::other("production configuration resolution failed"))?;
    resolved
        .validate_startup(&[])
        .map_err(|_| std::io::Error::other("production startup policy validation failed"))?;

    let config = resolved.config().clone();
    config.init_logging();

    let database_url = std::env::var("DATABASE_URL").map_err(|_| {
        std::io::Error::other("DATABASE_URL must be configured for the production profile")
    })?;
    let pool = connect_postgres(&database_url).await?;
    let store = PgDecisionStore::initialize(pool)
        .await
        .map_err(|_| std::io::Error::other("order decision schema initialization failed"))?;
    let resources = OrderResources::new(Arc::new(store));

    tracing::info!(
        profile = "production",
        adapter = "native",
        "starting canonical order-authorization service"
    );
    build_native_ingress()
        .config(&config)
        .run_managed(resources)
        .await
}
