use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use http::StatusCode;
use ranvier_core::prelude::{
    CancellationReason, CancellationToken, ResolvedRuntimeConfig, RuntimeProfile,
};
use ranvier_fullstack_backend::native::AuthorizationEnvelope;
use ranvier_fullstack_backend::{
    Fixture, InMemoryDecisionStore, OrderAuthorizationRequest, OrderAuthorizationResult, OrderItem,
    OrderResources, authorization_workflow, build_native_ingress,
};
use ranvier_http::prelude::{TestApp, TestRequest};

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

fn app() -> (TestApp<OrderResources>, OrderResources) {
    let resources = OrderResources::new(Arc::new(InMemoryDecisionStore::new()));
    (
        TestApp::new(build_native_ingress(), resources.clone()),
        resources,
    )
}

async fn post(
    app: &TestApp<OrderResources>,
    request: &OrderAuthorizationRequest,
) -> (StatusCode, AuthorizationEnvelope) {
    let request = TestRequest::post("/api/order-authorizations")
        .json(request)
        .expect("request must serialize");
    let response = app.send(request).await.expect("request must complete");
    let status = response.status();
    let body = response
        .json::<AuthorizationEnvelope>()
        .expect("response must be typed JSON");
    (status, body)
}

#[tokio::test]
async fn s1_valid_order_is_approved_with_one_durable_boundary() {
    let (app, resources) = app();
    let (status, body) = post(&app, &request("s1", Fixture::Normal)).await;

    assert_eq!(status, StatusCode::OK);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Ok {
            result: OrderAuthorizationResult::Approved { .. }
        }
    ));
    let evidence = resources.evidence().await.expect("evidence");
    assert_eq!(evidence.decisions.len(), 1);
    assert_eq!(evidence.audits.len(), 1);
    assert_eq!(evidence.side_effects.events.len(), 2);
    assert_eq!(evidence.side_effects.active_reservations.len(), 1);
    assert_eq!(evidence.side_effects.active_payment_authorizations.len(), 1);
}

#[tokio::test]
async fn s2_manual_review_has_no_external_side_effect() {
    let (app, resources) = app();
    let (status, body) = post(&app, &request("s2", Fixture::ManualReview)).await;

    assert_eq!(status, StatusCode::OK);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Ok {
            result: OrderAuthorizationResult::ManualReview { .. }
        }
    ));
    let evidence = resources.evidence().await.expect("evidence");
    assert!(evidence.side_effects.events.is_empty());
    assert_eq!(evidence.decisions.len(), 1);
    assert_eq!(evidence.audits[0].terminal_outcome, "manual_review");
}

#[tokio::test]
async fn s3_policy_rejection_has_no_external_side_effect() {
    let (app, resources) = app();
    let (status, body) = post(&app, &request("s3", Fixture::PolicyRejected)).await;

    assert_eq!(status, StatusCode::OK);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Ok {
            result: OrderAuthorizationResult::Rejected { .. }
        }
    ));
    let evidence = resources.evidence().await.expect("evidence");
    assert!(evidence.side_effects.events.is_empty());
    assert_eq!(evidence.decisions.len(), 1);
    assert_eq!(evidence.audits[0].terminal_outcome, "rejected");
}

#[tokio::test]
async fn s4_out_of_stock_is_structured_and_never_reaches_payment() {
    let (app, resources) = app();
    let (status, body) = post(&app, &request("s4", Fixture::OutOfStock)).await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Fault { ref fault }
            if fault.code == "inventory_out_of_stock" && fault.compensations.is_empty()
    ));
    let evidence = resources.evidence().await.expect("evidence");
    assert!(evidence.side_effects.events.is_empty());
    assert!(evidence.decisions.is_empty());
}

#[tokio::test]
async fn s5_payment_decline_releases_inventory_exactly_once() {
    let (app, resources) = app();
    let (status, body) = post(&app, &request("s5", Fixture::PaymentDeclined)).await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Fault { ref fault }
            if fault.code == "payment_declined"
                && fault.compensations.len() == 1
                && fault.compensations[0].action == "release_inventory"
    ));
    let evidence = resources.evidence().await.expect("evidence");
    let actions: Vec<_> = evidence
        .side_effects
        .events
        .iter()
        .map(|event| event.action.as_str())
        .collect();
    assert_eq!(actions, ["inventory_reserved", "inventory_released"]);
    assert!(evidence.side_effects.active_reservations.is_empty());
    assert!(evidence.decisions.is_empty());
}

#[tokio::test]
async fn s6_definite_decision_failure_compensates_in_reverse_order_once() {
    let (app, resources) = app();
    let (status, body) = post(&app, &request("s6", Fixture::DecisionWriteFailure)).await;

    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Fault { ref fault }
            if fault.code == "decision_write_failed"
                && fault.compensations.len() == 2
                && fault.compensations[0].action == "void_payment"
                && fault.compensations[1].action == "release_inventory"
    ));
    let evidence = resources.evidence().await.expect("evidence");
    let actions: Vec<_> = evidence
        .side_effects
        .events
        .iter()
        .map(|event| event.action.as_str())
        .collect();
    assert_eq!(
        actions,
        [
            "inventory_reserved",
            "payment_authorized",
            "payment_voided",
            "inventory_released"
        ]
    );
    assert!(evidence.decisions.is_empty());
    assert!(evidence.audits.is_empty());
}

#[tokio::test]
async fn s7_matching_retry_returns_original_without_repeating_effects() {
    let (app, resources) = app();
    let input = request("s7", Fixture::Normal);
    let first = post(&app, &input).await;
    let second = post(&app, &input).await;

    assert_eq!(first, second);
    let evidence = resources.evidence().await.expect("evidence");
    assert_eq!(evidence.decisions.len(), 1);
    assert_eq!(evidence.audits.len(), 1);
    assert_eq!(evidence.side_effects.events.len(), 2);
}

#[tokio::test]
async fn s8_lost_commit_ack_reconciles_before_any_compensation() {
    let (app, resources) = app();
    let (status, body) = post(&app, &request("s8", Fixture::AckLostAfterCommit)).await;

    assert_eq!(status, StatusCode::OK);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Ok {
            result: OrderAuthorizationResult::Approved { .. }
        }
    ));
    let evidence = resources.evidence().await.expect("evidence");
    assert_eq!(evidence.decisions.len(), 1);
    assert_eq!(evidence.audits.len(), 1);
    assert_eq!(evidence.side_effects.events.len(), 2);
    assert!(
        evidence
            .side_effects
            .events
            .iter()
            .all(|event| !event.action.contains("void") && !event.action.contains("released"))
    );
}

#[tokio::test]
async fn invalid_request_faults_before_side_effects() {
    let (app, resources) = app();
    let mut input = request("invalid", Fixture::Normal);
    input.items[0].quantity = 0;
    let (status, body) = post(&app, &input).await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(matches!(
        body,
        AuthorizationEnvelope::Fault { ref fault } if fault.code == "items_invalid"
    ));
    let evidence = resources.evidence().await.expect("evidence");
    assert!(evidence.side_effects.events.is_empty());
    assert!(evidence.decisions.is_empty());
}

#[test]
fn production_profile_is_explicit_and_passes_startup_policy_before_io() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ranvier.toml");
    let resolved = ResolvedRuntimeConfig::from_file_for(path, RuntimeProfile::Production)
        .expect("production config must resolve");
    let report = resolved
        .validate_startup(&[])
        .expect("production startup policy must pass");

    assert_eq!(resolved.profile(), RuntimeProfile::Production);
    assert_eq!(resolved.config().server.shutdown_timeout_secs, 30);
    assert!(!resolved.config().inspector.enabled);
    assert!(report.violation_codes().next().is_none());
}

#[test]
fn domain_schematic_names_every_canonical_step_without_runtime_values() {
    let serialized = serde_json::to_string(authorization_workflow().schematic())
        .expect("schematic must serialize");
    for step in [
        "ValidateRequest",
        "ResolveIdempotency",
        "ScreenPolicy",
        "ReserveInventory",
        "AuthorizePayment",
        "RecordDecision",
        "CompleteAuthorization",
    ] {
        assert!(serialized.contains(step), "missing {step}");
    }
    assert!(!serialized.contains("payment-token-001"));
}

#[tokio::test]
async fn native_lifecycle_honors_structured_graceful_shutdown() {
    let resources = OrderResources::new(Arc::new(InMemoryDecisionStore::new()));
    let started = Arc::new(AtomicBool::new(false));
    let stopped = Arc::new(AtomicBool::new(false));
    let started_hook = started.clone();
    let stopped_hook = stopped.clone();
    let token = CancellationToken::new();
    let task_token = token.clone();
    let ingress = build_native_ingress()
        .bind("127.0.0.1:0")
        .graceful_shutdown(Duration::from_millis(250))
        .on_start(move || started_hook.store(true, Ordering::SeqCst))
        .on_shutdown(move || stopped_hook.store(true, Ordering::SeqCst));

    let task =
        tokio::spawn(async move { ingress.run_with_cancellation(resources, task_token).await });
    tokio::time::timeout(Duration::from_secs(2), async {
        while !started.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("server must start");
    assert!(token.cancel(CancellationReason::OperatorShutdown));
    let result = tokio::time::timeout(Duration::from_secs(2), task)
        .await
        .expect("server must drain")
        .expect("server task must join");
    assert!(result.is_ok());
    assert!(stopped.load(Ordering::SeqCst));
}
