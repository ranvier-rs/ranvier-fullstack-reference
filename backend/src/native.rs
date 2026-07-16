use async_trait::async_trait;
use ranvier_core::prelude::*;
use ranvier_http::prelude::*;
use ranvier_runtime::Axon;

use crate::domain::{
    AuthorizationFault, EvidenceSnapshot, OrderAuthorizationRequest, OrderResources,
};
use crate::http_contract::{AuthorizationHttpResponse, execute_authorization};
use crate::startup::load_production_context;

pub use crate::http_contract::AuthorizationEnvelope;

impl IntoResponse for AuthorizationHttpResponse {
    fn into_response(self) -> HttpResponse {
        let (status, body) = self.into_parts();
        let mut response = Json(body).into_response();
        *response.status_mut() = status;
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
        let response =
            execute_authorization(request, resources, bus, "NativeHttpAuthorizationAdapter").await;
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

pub async fn run_native_from_env() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let context = load_production_context().await?;

    tracing::info!(
        profile = "production",
        adapter = "native",
        "starting canonical order-authorization service"
    );
    build_native_ingress()
        .config(&context.config)
        .run_managed(context.resources)
        .await
}
