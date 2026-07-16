use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use ranvier_fullstack_backend::{
    AuthorizationEnvelope, EvidenceSnapshot, Fixture, InMemoryDecisionStore,
    OrderAuthorizationRequest, OrderItem, OrderResources, build_hybrid_router,
    build_native_ingress, serve_hybrid_with_shutdown,
};
use ranvier_http::prelude::{TestApp, TestRequest};
use tower::ServiceExt;

fn request(scenario: &str, fixture: Fixture) -> OrderAuthorizationRequest {
    OrderAuthorizationRequest {
        order_id: format!("order-parity-{scenario}"),
        idempotency_key: format!("idem-parity-{scenario}"),
        customer_id: "customer-001".to_string(),
        items: vec![OrderItem {
            item_id: "sku-001".to_string(),
            quantity: 2,
        }],
        amount_minor: 12_500,
        currency: "USD".to_string(),
        payment_reference: "payment-token-001".to_string(),
        fixture,
    }
}

async fn native_post(
    app: &TestApp<OrderResources>,
    input: &OrderAuthorizationRequest,
) -> (StatusCode, AuthorizationEnvelope) {
    let request = TestRequest::post("/api/order-authorizations")
        .json(input)
        .expect("native request must serialize");
    let response = app
        .send(request)
        .await
        .expect("native request must complete");
    let status = response.status();
    let body = response
        .json::<AuthorizationEnvelope>()
        .expect("native response must be typed JSON");
    (status, body)
}

async fn hybrid_request(
    router: &Router,
    body: Body,
) -> (StatusCode, AuthorizationEnvelope, String) {
    let request = Request::builder()
        .method("POST")
        .uri("/api/order-authorizations")
        .header("content-type", "application/json")
        .body(body)
        .expect("hybrid request must build");
    let response = router
        .clone()
        .oneshot(request)
        .await
        .expect("hybrid request must complete");
    let status = response.status();
    let adapter = response
        .headers()
        .get("x-ranvier-adapter")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_string();
    let bytes = to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("hybrid response body must be bounded");
    let body = serde_json::from_slice::<AuthorizationEnvelope>(&bytes)
        .expect("hybrid response must be typed JSON");
    (status, body, adapter)
}

async fn hybrid_post(
    router: &Router,
    input: &OrderAuthorizationRequest,
) -> (StatusCode, AuthorizationEnvelope, String) {
    hybrid_request(
        router,
        Body::from(serde_json::to_vec(input).expect("hybrid request must serialize")),
    )
    .await
}

#[tokio::test]
async fn native_and_hybrid_match_s1_through_s8_and_redacted_evidence() {
    let native_resources = OrderResources::new(Arc::new(InMemoryDecisionStore::new()));
    let hybrid_resources = OrderResources::new(Arc::new(InMemoryDecisionStore::new()));
    let native = TestApp::new(build_native_ingress(), native_resources.clone());
    let hybrid = build_hybrid_router(hybrid_resources.clone());
    let scenarios = [
        request("s1", Fixture::Normal),
        request("s2", Fixture::ManualReview),
        request("s3", Fixture::PolicyRejected),
        request("s4", Fixture::OutOfStock),
        request("s5", Fixture::PaymentDeclined),
        request("s6", Fixture::DecisionWriteFailure),
        request("s7", Fixture::Normal),
        request("s7", Fixture::Normal),
        request("s8", Fixture::AckLostAfterCommit),
    ];

    for input in scenarios {
        let native_response = native_post(&native, &input).await;
        let (hybrid_status, hybrid_body, adapter) = hybrid_post(&hybrid, &input).await;
        assert_eq!(
            native_response,
            (hybrid_status, hybrid_body),
            "adapter result diverged for {:?}",
            input.fixture
        );
        assert_eq!(adapter, "axum-tower-hybrid");
    }

    let native_evidence = native_resources.evidence().await.expect("native evidence");
    let hybrid_evidence = hybrid_resources.evidence().await.expect("hybrid evidence");
    assert_eq!(native_evidence, hybrid_evidence);
    assert_eq!(native_evidence.decisions.len(), 5);
    assert_eq!(native_evidence.audits.len(), 5);
    assert_eq!(native_evidence.side_effects.events.len(), 12);
}

#[tokio::test]
async fn hybrid_rejects_malformed_json_with_the_stable_fault_envelope() {
    let resources = OrderResources::new(Arc::new(InMemoryDecisionStore::new()));
    let router = build_hybrid_router(resources.clone());
    let (status, body, adapter) =
        hybrid_request(&router, Body::from(br#"{"order_id":12}"#.to_vec())).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Fault { ref fault }
            if fault.code == "request_json_invalid" && !fault.retryable
    ));
    assert_eq!(adapter, "axum-tower-hybrid");
    assert_eq!(
        resources.evidence().await.expect("evidence"),
        EvidenceSnapshot::default()
    );
}

#[tokio::test]
async fn axum_owns_a_bounded_graceful_shutdown_lifecycle() {
    let resources = OrderResources::new(Arc::new(InMemoryDecisionStore::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener must bind");
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(serve_hybrid_with_shutdown(
        listener,
        resources,
        async move {
            let _ = shutdown_rx.await;
        },
        Duration::from_millis(250),
    ));

    tokio::task::yield_now().await;
    shutdown_tx.send(()).expect("shutdown must signal");
    tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("hybrid server must stop")
        .expect("hybrid task must join")
        .expect("hybrid shutdown must pass");
}
