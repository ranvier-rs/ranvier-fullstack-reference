use std::future::{Future, IntoFuture};
use std::time::Duration;

use axum::body::Body;
use axum::extract::rejection::JsonRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderValue, Request};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ranvier_core::prelude::Bus;
use tower::ServiceBuilder;
use tower::limit::ConcurrencyLimitLayer;

use crate::domain::{EvidenceSnapshot, OrderAuthorizationRequest, OrderResources};
use crate::http_contract::{AuthorizationHttpResponse, execute_authorization};
use crate::startup::load_production_context;

impl IntoResponse for AuthorizationHttpResponse {
    fn into_response(self) -> Response {
        let (status, body) = self.into_parts();
        (status, Json(body)).into_response()
    }
}

#[derive(Clone)]
struct HybridState {
    resources: OrderResources,
}

async fn authorize(
    State(state): State<HybridState>,
    payload: Result<Json<OrderAuthorizationRequest>, JsonRejection>,
) -> Response {
    let Json(request) = match payload {
        Ok(request) => request,
        Err(_) => {
            return AuthorizationHttpResponse::invalid_json("HybridHttpAuthorizationAdapter")
                .into_response();
        }
    };
    let mut bus = Bus::new();
    execute_authorization(
        request,
        &state.resources,
        &mut bus,
        "HybridHttpAuthorizationAdapter",
    )
    .await
    .into_response()
}

async fn evidence(State(state): State<HybridState>) -> Response {
    match state.resources.evidence().await {
        Ok(evidence) => Json::<EvidenceSnapshot>(evidence).into_response(),
        Err(fault) => AuthorizationHttpResponse::fault(fault).into_response(),
    }
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "service": "order-authorization-hybrid",
        "ranvier_candidate": "0.51.0-m420.1"
    }))
}

async fn adapter_headers(request: Request<Body>, next: Next) -> Response {
    let mut response = next.run(request).await;
    response.headers_mut().insert(
        "x-ranvier-adapter",
        HeaderValue::from_static("axum-tower-hybrid"),
    );
    response
}

pub fn build_hybrid_router(resources: OrderResources) -> Router {
    Router::new()
        .route("/api/order-authorizations", post(authorize))
        .route("/api/order-authorizations/evidence", get(evidence))
        .route("/api/health", get(health))
        .with_state(HybridState { resources })
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(
            ServiceBuilder::new()
                .layer(ConcurrencyLimitLayer::new(256))
                .layer(middleware::from_fn(adapter_headers)),
        )
}

pub async fn serve_hybrid_with_shutdown<F>(
    listener: tokio::net::TcpListener,
    resources: OrderResources,
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
    let server = axum::serve(listener, build_hybrid_router(resources))
        .with_graceful_shutdown(signal)
        .into_future();
    tokio::pin!(server);

    tokio::select! {
        result = &mut server => result,
        started = drain_started_rx => {
            if started.is_err() {
                return Err(std::io::Error::other("hybrid shutdown signal channel closed"));
            }
            match tokio::time::timeout(drain_timeout, &mut server).await {
                Ok(result) => result,
                Err(_) => Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "hybrid graceful shutdown exceeded the configured deadline",
                )),
            }
        }
    }
}

#[cfg(unix)]
async fn operating_system_shutdown() {
    use tokio::signal::unix::{SignalKind, signal};

    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn operating_system_shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

pub async fn run_hybrid_from_env() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let context = load_production_context().await?;
    let bind_addr = context.config.bind_addr();
    let drain_timeout = Duration::from_secs(context.config.server.shutdown_timeout_secs);
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;

    tracing::info!(
        profile = "production",
        adapter = "axum-tower-hybrid",
        bind = %bind_addr,
        "starting canonical order-authorization service"
    );
    serve_hybrid_with_shutdown(
        listener,
        context.resources,
        operating_system_shutdown(),
        drain_timeout,
    )
    .await?;
    Ok(())
}
