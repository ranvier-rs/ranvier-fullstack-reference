use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::store::{
    DecisionStore, FailureCertainty, RecordMode, RecordStatus, StoreFailure, StoredDecision,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrderItem {
    pub item_id: String,
    pub quantity: u32,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Fixture {
    #[default]
    Normal,
    ManualReview,
    PolicyRejected,
    OutOfStock,
    PaymentDeclined,
    DecisionWriteFailure,
    AckLostAfterCommit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OrderAuthorizationRequest {
    pub order_id: String,
    pub idempotency_key: String,
    pub customer_id: String,
    pub items: Vec<OrderItem>,
    pub amount_minor: i64,
    pub currency: String,
    pub payment_reference: String,
    #[serde(default)]
    pub fixture: Fixture,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum OrderAuthorizationResult {
    Approved {
        order_id: String,
        reservation_id: String,
        payment_authorization_id: String,
        decision_id: String,
    },
    ManualReview {
        order_id: String,
        reason_codes: Vec<String>,
    },
    Rejected {
        order_id: String,
        reason_codes: Vec<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompensationOutcome {
    pub action: String,
    pub resource_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorizationFault {
    pub code: String,
    pub failed_step: String,
    pub message: String,
    pub order_id: String,
    pub idempotency_key: String,
    pub retryable: bool,
    pub operator_action_required: bool,
    pub compensations: Vec<CompensationOutcome>,
}

impl AuthorizationFault {
    fn new(
        request: &OrderAuthorizationRequest,
        code: &str,
        failed_step: &str,
        message: &str,
        retryable: bool,
    ) -> Self {
        Self {
            code: code.to_string(),
            failed_step: failed_step.to_string(),
            message: message.to_string(),
            order_id: request.order_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            retryable,
            operator_action_required: false,
            compensations: Vec::new(),
        }
    }

    fn with_compensations(mut self, compensations: Vec<CompensationOutcome>) -> Self {
        self.compensations = compensations;
        self
    }

    fn requiring_operator(mut self) -> Self {
        self.operator_action_required = true;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuthorizationEnvelope {
    Ok { result: OrderAuthorizationResult },
    Fault { fault: AuthorizationFault },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditRecord {
    pub event_type: String,
    pub decision_id: String,
    pub order_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub correlation_id: String,
    pub terminal_outcome: String,
    pub reason_codes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SideEffectEvent {
    pub sequence: u64,
    pub action: String,
    pub order_id: String,
    pub resource_id: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DomainTraceEvent {
    pub sequence: u64,
    pub correlation_id: String,
    pub order_id: String,
    pub step: String,
    pub state: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SideEffectSnapshot {
    pub events: Vec<SideEffectEvent>,
    pub active_reservations: Vec<String>,
    pub active_payment_authorizations: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct EvidenceSnapshot {
    pub decisions: Vec<StoredDecisionEvidence>,
    pub audits: Vec<AuditRecord>,
    pub side_effects: SideEffectSnapshot,
    pub traces: Vec<DomainTraceEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredDecisionEvidence {
    pub decision_id: String,
    pub order_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub result: OrderAuthorizationResult,
}

impl From<StoredDecision> for StoredDecisionEvidence {
    fn from(value: StoredDecision) -> Self {
        Self {
            decision_id: value.decision_id,
            order_id: value.order_id,
            idempotency_key: value.idempotency_key,
            request_digest: value.request_digest,
            result: value.result,
        }
    }
}

#[derive(Default)]
struct EffectState {
    next_sequence: u64,
    reservations: BTreeMap<String, bool>,
    payments: BTreeMap<String, bool>,
    events: Vec<SideEffectEvent>,
    traces: Vec<DomainTraceEvent>,
}

#[derive(Clone)]
pub struct OrderService {
    store: Arc<dyn DecisionStore>,
    effects: Arc<Mutex<EffectState>>,
}

impl OrderService {
    pub fn new(store: Arc<dyn DecisionStore>) -> Self {
        Self {
            store,
            effects: Arc::new(Mutex::new(EffectState::default())),
        }
    }

    pub async fn authorize(
        &self,
        request: OrderAuthorizationRequest,
    ) -> Result<OrderAuthorizationResult, AuthorizationFault> {
        let mut state = self.validate(request).await?;
        self.resolve_idempotency(&mut state).await?;
        self.screen_policy(&mut state).await;
        self.reserve_inventory(&mut state).await?;
        self.authorize_payment(&mut state).await?;
        self.record_decision(&mut state).await?;
        self.complete(state).await
    }

    pub async fn evidence(&self) -> Result<EvidenceSnapshot, AuthorizationFault> {
        let decisions = self
            .store
            .decisions()
            .await
            .map_err(|error| evidence_fault("decision_evidence_read_failed", error))?;
        let audits = self
            .store
            .audits()
            .await
            .map_err(|error| evidence_fault("audit_evidence_read_failed", error))?;
        let effects = self.effects.lock().await;

        Ok(EvidenceSnapshot {
            decisions: decisions.into_iter().map(Into::into).collect(),
            audits,
            side_effects: SideEffectSnapshot {
                events: effects.events.clone(),
                active_reservations: active_keys(&effects.reservations),
                active_payment_authorizations: active_keys(&effects.payments),
            },
            traces: effects.traces.clone(),
        })
    }

    async fn validate(
        &self,
        request: OrderAuthorizationRequest,
    ) -> Result<WorkflowState, AuthorizationFault> {
        self.trace(&request, "ValidateRequest", "entered").await;
        if let Err(code) = validate_request(&request) {
            self.trace(&request, "ValidateRequest", "fault").await;
            return Err(AuthorizationFault::new(
                &request,
                code,
                "ValidateRequest",
                "request failed canonical validation",
                false,
            ));
        }
        let request_digest = match serde_json::to_vec(&request) {
            Ok(encoded) => hex_digest(&encoded),
            Err(_) => {
                self.trace(&request, "ValidateRequest", "fault").await;
                return Err(AuthorizationFault::new(
                    &request,
                    "request_digest_failed",
                    "ValidateRequest",
                    "validated request could not be canonicalized",
                    false,
                ));
            }
        };
        self.trace(&request, "ValidateRequest", "next").await;
        Ok(WorkflowState {
            request,
            request_digest,
            replayed: false,
            result: None,
            reservation_id: None,
            payment_id: None,
        })
    }

    async fn resolve_idempotency(
        &self,
        state: &mut WorkflowState,
    ) -> Result<(), AuthorizationFault> {
        self.trace(&state.request, "ResolveIdempotency", "entered")
            .await;
        match self.store.find(&state.request.idempotency_key).await {
            Ok(Some(existing)) if existing.request_digest == state.request_digest => {
                state.replayed = true;
                state.result = Some(existing.result);
            }
            Ok(Some(_)) => {
                self.trace(&state.request, "ResolveIdempotency", "fault")
                    .await;
                return Err(AuthorizationFault::new(
                    &state.request,
                    "idempotency_key_conflict",
                    "ResolveIdempotency",
                    "idempotency key was already used for a different request",
                    false,
                ));
            }
            Ok(None) => {}
            Err(_) => {
                self.trace(&state.request, "ResolveIdempotency", "fault")
                    .await;
                return Err(AuthorizationFault::new(
                    &state.request,
                    "idempotency_lookup_failed",
                    "ResolveIdempotency",
                    "durable idempotency state could not be read",
                    true,
                )
                .requiring_operator());
            }
        }
        self.trace(&state.request, "ResolveIdempotency", "next")
            .await;
        Ok(())
    }

    async fn screen_policy(&self, state: &mut WorkflowState) {
        self.trace(&state.request, "ScreenPolicy", "entered").await;
        if !state.replayed {
            state.result = match state.request.fixture {
                Fixture::ManualReview => Some(OrderAuthorizationResult::ManualReview {
                    order_id: state.request.order_id.clone(),
                    reason_codes: vec!["risk_review_required".to_string()],
                }),
                Fixture::PolicyRejected => Some(OrderAuthorizationResult::Rejected {
                    order_id: state.request.order_id.clone(),
                    reason_codes: vec!["policy_rejected".to_string()],
                }),
                _ => None,
            };
        }
        self.trace(&state.request, "ScreenPolicy", "next").await;
    }

    async fn reserve_inventory(&self, state: &mut WorkflowState) -> Result<(), AuthorizationFault> {
        self.trace(&state.request, "ReserveInventory", "entered")
            .await;
        if !state.replayed && state.result.is_none() {
            if state.request.fixture == Fixture::OutOfStock {
                self.trace(&state.request, "ReserveInventory", "fault")
                    .await;
                return Err(AuthorizationFault::new(
                    &state.request,
                    "inventory_out_of_stock",
                    "ReserveInventory",
                    "inventory could not satisfy the requested quantity",
                    false,
                ));
            }
            let reservation_id = stable_id("res", &state.request.order_id);
            let mut effects = self.effects.lock().await;
            if effects.reservations.get(&reservation_id) != Some(&true) {
                effects.reservations.insert(reservation_id.clone(), true);
                push_effect_event(
                    &mut effects,
                    "inventory_reserved",
                    &state.request.order_id,
                    &reservation_id,
                );
            }
            state.reservation_id = Some(reservation_id);
        }
        self.trace(&state.request, "ReserveInventory", "next").await;
        Ok(())
    }

    async fn authorize_payment(&self, state: &mut WorkflowState) -> Result<(), AuthorizationFault> {
        self.trace(&state.request, "AuthorizePayment", "entered")
            .await;
        if !state.replayed && state.result.is_none() {
            if state.request.fixture == Fixture::PaymentDeclined {
                let compensations = self
                    .compensate(&state.request, None, state.reservation_id.as_deref())
                    .await;
                self.trace(&state.request, "AuthorizePayment", "fault")
                    .await;
                return Err(AuthorizationFault::new(
                    &state.request,
                    "payment_declined",
                    "AuthorizePayment",
                    "payment authorization was declined",
                    false,
                )
                .with_compensations(compensations));
            }
            let payment_id = stable_id("pay", &state.request.order_id);
            let mut effects = self.effects.lock().await;
            if effects.payments.get(&payment_id) != Some(&true) {
                effects.payments.insert(payment_id.clone(), true);
                push_effect_event(
                    &mut effects,
                    "payment_authorized",
                    &state.request.order_id,
                    &payment_id,
                );
            }
            state.payment_id = Some(payment_id);
        }
        self.trace(&state.request, "AuthorizePayment", "next").await;
        Ok(())
    }

    async fn record_decision(&self, state: &mut WorkflowState) -> Result<(), AuthorizationFault> {
        self.trace(&state.request, "RecordDecision", "entered")
            .await;
        if state.replayed {
            self.trace(&state.request, "RecordDecision", "next").await;
            return Ok(());
        }

        let decision_id = stable_id("dec", &state.request_digest);
        let result = match state.result.clone() {
            Some(result) => result,
            None => match self.approved_result(state, &decision_id) {
                Some(result) => result,
                None => {
                    let compensations = self.compensate_state(state).await;
                    self.trace(&state.request, "RecordDecision", "fault").await;
                    return Err(AuthorizationFault::new(
                        &state.request,
                        "workflow_state_invalid",
                        "RecordDecision",
                        "inventory reservation or payment authorization is missing",
                        false,
                    )
                    .with_compensations(compensations)
                    .requiring_operator());
                }
            },
        };
        let decision = StoredDecision {
            decision_id: decision_id.clone(),
            order_id: state.request.order_id.clone(),
            idempotency_key: state.request.idempotency_key.clone(),
            request_digest: state.request_digest.clone(),
            result: result.clone(),
        };
        let mode = match state.request.fixture {
            Fixture::DecisionWriteFailure => RecordMode::DefiniteFailure,
            Fixture::AckLostAfterCommit => RecordMode::LoseCommitAcknowledgement,
            _ => RecordMode::Normal,
        };

        match self
            .store
            .record(decision, audit_record(state, &decision_id, &result), mode)
            .await
        {
            Ok(RecordStatus::Inserted) => state.result = Some(result),
            Ok(RecordStatus::Existing(existing)) => {
                if existing.request_digest != state.request_digest {
                    let compensations = self.compensate_state(state).await;
                    self.trace(&state.request, "RecordDecision", "fault").await;
                    return Err(AuthorizationFault::new(
                        &state.request,
                        "idempotency_key_conflict",
                        "RecordDecision",
                        "a concurrent request used the idempotency key with different input",
                        false,
                    )
                    .with_compensations(compensations));
                }
                state.result = Some(existing.result);
            }
            Err(error) if error.certainty == FailureCertainty::DefiniteNoCommit => {
                let compensations = self.compensate_state(state).await;
                self.trace(&state.request, "RecordDecision", "fault").await;
                return Err(AuthorizationFault::new(
                    &state.request,
                    error.code,
                    "RecordDecision",
                    "decision and audit were not committed",
                    true,
                )
                .with_compensations(compensations));
            }
            Err(error) => self.reconcile_unknown(state, error).await?,
        }

        self.trace(&state.request, "RecordDecision", "next").await;
        Ok(())
    }

    fn approved_result(
        &self,
        state: &WorkflowState,
        decision_id: &str,
    ) -> Option<OrderAuthorizationResult> {
        let reservation_id = state.reservation_id.clone()?;
        let payment_authorization_id = state.payment_id.clone()?;
        Some(OrderAuthorizationResult::Approved {
            order_id: state.request.order_id.clone(),
            reservation_id,
            payment_authorization_id,
            decision_id: decision_id.to_string(),
        })
    }

    async fn reconcile_unknown(
        &self,
        state: &mut WorkflowState,
        error: StoreFailure,
    ) -> Result<(), AuthorizationFault> {
        match self.store.find(&state.request.idempotency_key).await {
            Ok(Some(existing)) if existing.request_digest == state.request_digest => {
                state.result = Some(existing.result);
                Ok(())
            }
            Ok(Some(_)) => {
                let compensations = self.compensate_state(state).await;
                self.trace(&state.request, "RecordDecision", "fault").await;
                Err(AuthorizationFault::new(
                    &state.request,
                    "decision_reconciliation_conflict",
                    "RecordDecision",
                    "unknown commit outcome reconciled to a different request",
                    false,
                )
                .with_compensations(compensations))
            }
            Ok(None) => {
                let compensations = self.compensate_state(state).await;
                self.trace(&state.request, "RecordDecision", "fault").await;
                Err(AuthorizationFault::new(
                    &state.request,
                    "decision_absence_proven_after_unknown_commit",
                    "RecordDecision",
                    "decision absence was proven after an unknown commit outcome",
                    true,
                )
                .with_compensations(compensations))
            }
            Err(_) => {
                self.trace(&state.request, "RecordDecision", "fault").await;
                Err(AuthorizationFault::new(
                    &state.request,
                    error.code,
                    "RecordDecision",
                    "commit outcome remains unknown; blind compensation was suppressed",
                    true,
                )
                .requiring_operator())
            }
        }
    }

    async fn complete(
        &self,
        state: WorkflowState,
    ) -> Result<OrderAuthorizationResult, AuthorizationFault> {
        self.trace(&state.request, "CompleteAuthorization", "entered")
            .await;
        match state.result {
            Some(result) => {
                self.trace(&state.request, "CompleteAuthorization", "next")
                    .await;
                Ok(result)
            }
            None => {
                self.trace(&state.request, "CompleteAuthorization", "fault")
                    .await;
                Err(AuthorizationFault::new(
                    &state.request,
                    "workflow_result_missing",
                    "CompleteAuthorization",
                    "durable terminal result is missing",
                    false,
                )
                .requiring_operator())
            }
        }
    }

    async fn compensate_state(&self, state: &WorkflowState) -> Vec<CompensationOutcome> {
        self.compensate(
            &state.request,
            state.payment_id.as_deref(),
            state.reservation_id.as_deref(),
        )
        .await
    }

    async fn compensate(
        &self,
        request: &OrderAuthorizationRequest,
        payment_id: Option<&str>,
        reservation_id: Option<&str>,
    ) -> Vec<CompensationOutcome> {
        let mut effects = self.effects.lock().await;
        let mut outcomes = Vec::new();
        if let Some(id) = payment_id {
            let applied = effects.payments.get(id) == Some(&true);
            if applied {
                effects.payments.insert(id.to_string(), false);
                push_effect_event(&mut effects, "payment_voided", &request.order_id, id);
            }
            outcomes.push(compensation("void_payment", id, applied));
        }
        if let Some(id) = reservation_id {
            let applied = effects.reservations.get(id) == Some(&true);
            if applied {
                effects.reservations.insert(id.to_string(), false);
                push_effect_event(&mut effects, "inventory_released", &request.order_id, id);
            }
            outcomes.push(compensation("release_inventory", id, applied));
        }
        outcomes
    }

    async fn trace(&self, request: &OrderAuthorizationRequest, step: &str, state: &str) {
        let mut effects = self.effects.lock().await;
        effects.next_sequence = effects.next_sequence.saturating_add(1);
        let sequence = effects.next_sequence;
        effects.traces.push(DomainTraceEvent {
            sequence,
            correlation_id: correlation_id(request),
            order_id: request.order_id.clone(),
            step: step.to_string(),
            state: state.to_string(),
        });
    }
}

struct WorkflowState {
    request: OrderAuthorizationRequest,
    request_digest: String,
    replayed: bool,
    result: Option<OrderAuthorizationResult>,
    reservation_id: Option<String>,
    payment_id: Option<String>,
}

fn active_keys(values: &BTreeMap<String, bool>) -> Vec<String> {
    values
        .iter()
        .filter(|(_, active)| **active)
        .map(|(id, _)| id.clone())
        .collect()
}

fn compensation(action: &str, resource_id: &str, applied: bool) -> CompensationOutcome {
    CompensationOutcome {
        action: action.to_string(),
        resource_id: resource_id.to_string(),
        status: if applied {
            "applied"
        } else {
            "already_applied"
        }
        .to_string(),
    }
}

fn push_effect_event(state: &mut EffectState, action: &str, order_id: &str, resource_id: &str) {
    state.next_sequence = state.next_sequence.saturating_add(1);
    state.events.push(SideEffectEvent {
        sequence: state.next_sequence,
        action: action.to_string(),
        order_id: order_id.to_string(),
        resource_id: resource_id.to_string(),
        status: "applied".to_string(),
    });
}

fn evidence_fault(code: &'static str, error: StoreFailure) -> AuthorizationFault {
    AuthorizationFault {
        code: code.to_string(),
        failed_step: "ReadEvidence".to_string(),
        message: "redacted evidence could not be read".to_string(),
        order_id: "evidence".to_string(),
        idempotency_key: "evidence".to_string(),
        retryable: true,
        operator_action_required: error.certainty == FailureCertainty::CommitUnknown,
        compensations: Vec::new(),
    }
}

fn audit_record(
    state: &WorkflowState,
    decision_id: &str,
    result: &OrderAuthorizationResult,
) -> AuditRecord {
    let (terminal_outcome, reason_codes) = match result {
        OrderAuthorizationResult::Approved { .. } => ("approved", Vec::new()),
        OrderAuthorizationResult::ManualReview { reason_codes, .. } => {
            ("manual_review", reason_codes.clone())
        }
        OrderAuthorizationResult::Rejected { reason_codes, .. } => {
            ("rejected", reason_codes.clone())
        }
    };
    AuditRecord {
        event_type: "order_authorization_recorded".to_string(),
        decision_id: decision_id.to_string(),
        order_id: state.request.order_id.clone(),
        idempotency_key: state.request.idempotency_key.clone(),
        request_digest: state.request_digest.clone(),
        correlation_id: correlation_id(&state.request),
        terminal_outcome: terminal_outcome.to_string(),
        reason_codes,
    }
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn validate_request(request: &OrderAuthorizationRequest) -> Result<(), &'static str> {
    if !valid_identifier(&request.order_id) {
        return Err("order_id_invalid");
    }
    if !valid_identifier(&request.idempotency_key) {
        return Err("idempotency_key_invalid");
    }
    if !valid_identifier(&request.customer_id) {
        return Err("customer_id_invalid");
    }
    if !valid_identifier(&request.payment_reference) {
        return Err("payment_reference_invalid");
    }
    if request.items.is_empty()
        || request
            .items
            .iter()
            .any(|item| !valid_identifier(&item.item_id) || item.quantity == 0)
    {
        return Err("items_invalid");
    }
    if request.amount_minor <= 0 {
        return Err("amount_invalid");
    }
    if request.currency.len() != 3
        || !request
            .currency
            .bytes()
            .all(|byte| byte.is_ascii_uppercase())
    {
        return Err("currency_invalid");
    }
    Ok(())
}

fn hex_digest(value: &[u8]) -> String {
    Sha256::digest(value)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn stable_id(prefix: &str, seed: &str) -> String {
    let digest = hex_digest(seed.as_bytes());
    format!("{prefix}-{}", &digest[..16])
}

fn correlation_id(request: &OrderAuthorizationRequest) -> String {
    stable_id(
        "cor",
        &format!("{}:{}", request.order_id, request.idempotency_key),
    )
}
