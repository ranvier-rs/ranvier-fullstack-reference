use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use http::{Request, StatusCode};
use http_body_util::BodyExt;
use plain_axum_order_authorization::{
    AuthorizationEnvelope, Fixture, InMemoryDecisionStore, OrderAuthorizationRequest,
    OrderAuthorizationResult, OrderItem, OrderService, build_router, serve_with_shutdown,
};
use tower::ServiceExt;

fn request(scenario: &str, fixture: Fixture) -> OrderAuthorizationRequest {
    OrderAuthorizationRequest {
        order_id: format!("order-{scenario}"),
        idempotency_key: format!("idem-{scenario}"),
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

fn app() -> (axum::Router, OrderService) {
    let service = OrderService::new(Arc::new(InMemoryDecisionStore::new()));
    (build_router(service.clone()), service)
}

async fn post(
    app: &axum::Router,
    request: &OrderAuthorizationRequest,
) -> (StatusCode, AuthorizationEnvelope) {
    let body = serde_json::to_vec(request).expect("request must serialize");
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/order-authorizations")
                .header("content-type", "application/json")
                .body(Body::from(body))
                .expect("request must build"),
        )
        .await
        .expect("request must complete");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body must collect")
        .to_bytes();
    let envelope = serde_json::from_slice(&bytes).expect("response must be typed JSON");
    (status, envelope)
}

#[tokio::test]
async fn s1_to_s8_preserve_the_frozen_control_contract() {
    let (app, service) = app();

    let s1 = post(&app, &request("s1", Fixture::Normal)).await;
    assert_eq!(s1.0, StatusCode::OK);
    assert!(matches!(
        s1.1,
        AuthorizationEnvelope::Ok {
            result: OrderAuthorizationResult::Approved { .. }
        }
    ));

    let s2 = post(&app, &request("s2", Fixture::ManualReview)).await;
    assert!(matches!(
        s2,
        (
            StatusCode::OK,
            AuthorizationEnvelope::Ok {
                result: OrderAuthorizationResult::ManualReview { .. }
            }
        )
    ));

    let s3 = post(&app, &request("s3", Fixture::PolicyRejected)).await;
    assert!(matches!(
        s3,
        (
            StatusCode::OK,
            AuthorizationEnvelope::Ok {
                result: OrderAuthorizationResult::Rejected { .. }
            }
        )
    ));

    let s4 = post(&app, &request("s4", Fixture::OutOfStock)).await;
    assert!(matches!(
        s4,
        (StatusCode::UNPROCESSABLE_ENTITY, AuthorizationEnvelope::Fault { ref fault })
            if fault.code == "inventory_out_of_stock" && fault.compensations.is_empty()
    ));

    let s5 = post(&app, &request("s5", Fixture::PaymentDeclined)).await;
    assert!(matches!(
        s5,
        (StatusCode::UNPROCESSABLE_ENTITY, AuthorizationEnvelope::Fault { ref fault })
            if fault.code == "payment_declined"
                && fault.compensations.len() == 1
                && fault.compensations[0].action == "release_inventory"
    ));

    let s6 = post(&app, &request("s6", Fixture::DecisionWriteFailure)).await;
    assert!(matches!(
        s6,
        (StatusCode::SERVICE_UNAVAILABLE, AuthorizationEnvelope::Fault { ref fault })
            if fault.code == "decision_write_failed"
                && fault.compensations.len() == 2
                && fault.compensations[0].action == "void_payment"
                && fault.compensations[1].action == "release_inventory"
    ));

    let s7_request = request("s7", Fixture::Normal);
    let s7_first = post(&app, &s7_request).await;
    let s7_retry = post(&app, &s7_request).await;
    assert_eq!(s7_first, s7_retry);

    let s8 = post(&app, &request("s8", Fixture::AckLostAfterCommit)).await;
    assert!(matches!(
        s8,
        (
            StatusCode::OK,
            AuthorizationEnvelope::Ok {
                result: OrderAuthorizationResult::Approved { .. }
            }
        )
    ));

    let evidence = service.evidence().await.expect("evidence must load");
    assert_eq!(evidence.decisions.len(), 5);
    assert_eq!(evidence.audits.len(), 5);
    assert_eq!(evidence.side_effects.events.len(), 12);
    assert_eq!(
        evidence
            .side_effects
            .events
            .iter()
            .filter(|event| event.action == "inventory_released")
            .count(),
        2
    );
    assert_eq!(
        evidence
            .side_effects
            .events
            .iter()
            .filter(|event| event.action == "payment_voided")
            .count(),
        1
    );
    assert!(
        evidence
            .side_effects
            .events
            .iter()
            .filter(|event| event.order_id == "order-s8")
            .all(|event| !matches!(
                event.action.as_str(),
                "payment_voided" | "inventory_released"
            ))
    );
    assert_eq!(evidence.traces.len(), 114);
}

#[tokio::test]
async fn malformed_json_is_typed_and_has_no_side_effect() {
    let (app, service) = app();
    let response = app
        .oneshot(
            Request::post("/api/order-authorizations")
                .header("content-type", "application/json")
                .body(Body::from("{"))
                .expect("request must build"),
        )
        .await
        .expect("request must complete");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body must collect")
        .to_bytes();
    let body: AuthorizationEnvelope =
        serde_json::from_slice(&bytes).expect("response must deserialize");
    assert!(matches!(
        body,
        AuthorizationEnvelope::Fault { fault } if fault.code == "request_json_invalid"
    ));
    let evidence = service.evidence().await.expect("evidence must load");
    assert!(evidence.side_effects.events.is_empty());
}

#[tokio::test]
async fn lifecycle_honors_bounded_graceful_shutdown() {
    let service = OrderService::new(Arc::new(InMemoryDecisionStore::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("listener must bind");
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(serve_with_shutdown(
        listener,
        service,
        async move {
            let _ = shutdown_rx.await;
        },
        Duration::from_millis(250),
    ));
    shutdown_tx.send(()).expect("shutdown must send");
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("server must drain")
        .expect("task must join");
    assert!(result.is_ok());
}
