use std::future::{Future, IntoFuture};
use std::time::Duration;

use axum::body::Body;
use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use tower::ServiceBuilder;
use tower::limit::ConcurrencyLimitLayer;

use crate::domain::{
    AuthorizationEnvelope, AuthorizationFault, OrderAuthorizationRequest, OrderService,
};

async fn authorize(
    State(service): State<OrderService>,
    payload: Result<Json<OrderAuthorizationRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(request) => request,
        Err(_) => return fault_response(invalid_json_fault()),
    };
    match service.authorize(request).await {
        Ok(result) => (StatusCode::OK, Json(AuthorizationEnvelope::Ok { result })).into_response(),
        Err(fault) => fault_response(fault),
    }
}

async fn evidence(State(service): State<OrderService>) -> Response {
    match service.evidence().await {
        Ok(evidence) => Json(evidence).into_response(),
        Err(fault) => fault_response(fault),
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "order-authorization-plain-axum-control"
    }))
}

async fn adapter_headers(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "x-control-adapter",
        HeaderValue::from_static("plain-axum-tower"),
    );
    response
}

fn invalid_json_fault() -> AuthorizationFault {
    AuthorizationFault {
        code: "request_json_invalid".to_string(),
        failed_step: "PlainAxumJsonExtractor".to_string(),
        message: "request body did not match the typed order contract".to_string(),
        order_id: String::new(),
        idempotency_key: String::new(),
        retryable: false,
        operator_action_required: false,
        compensations: Vec::new(),
    }
}

fn fault_response(fault: AuthorizationFault) -> Response {
    let status = match fault.code.as_str() {
        "order_id_invalid"
        | "idempotency_key_invalid"
        | "customer_id_invalid"
        | "payment_reference_invalid"
        | "items_invalid"
        | "amount_invalid"
        | "currency_invalid"
        | "request_json_invalid" => StatusCode::BAD_REQUEST,
        "idempotency_key_conflict" | "decision_reconciliation_conflict" => StatusCode::CONFLICT,
        "inventory_out_of_stock" | "payment_declined" => StatusCode::UNPROCESSABLE_ENTITY,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    };
    (status, Json(AuthorizationEnvelope::Fault { fault })).into_response()
}

pub fn build_router(service: OrderService) -> Router {
    Router::new()
        .route("/api/order-authorizations", post(authorize))
        .route("/api/order-authorizations/evidence", get(evidence))
        .route("/api/health", get(health))
        .with_state(service)
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(
            ServiceBuilder::new()
                .layer(ConcurrencyLimitLayer::new(256))
                .layer(middleware::from_fn(adapter_headers)),
        )
}

pub async fn serve_with_shutdown<F>(
    listener: tokio::net::TcpListener,
    service: OrderService,
    shutdown: F,
    drain_timeout: Duration,
) -> Result<(), std::io::Error>
where
    F: Future<Output = ()> + Send + 'static,
{
    let (drain_started_tx, drain_started_rx) = tokio::sync::oneshot::channel();
    let signal = async move {
        shutdown.await;
        let _ = drain_started_tx.send(());
    };
    let server = axum::serve(listener, build_router(service))
        .with_graceful_shutdown(signal)
        .into_future();
    tokio::pin!(server);

    tokio::select! {
        result = &mut server => result,
        started = drain_started_rx => {
            if started.is_err() {
                return Err(std::io::Error::other("control shutdown signal channel closed"));
            }
            match tokio::time::timeout(drain_timeout, &mut server).await {
                Ok(result) => result,
                Err(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "control graceful shutdown exceeded the configured deadline",
                )),
            }
        }
    }
}
