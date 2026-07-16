use ranvier_core::prelude::{Bus, Outcome};
use serde::{Deserialize, Serialize};

use crate::domain::{
    AuthorizationFault, OrderAuthorizationRequest, OrderAuthorizationResult, OrderResources,
    authorization_workflow,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AuthorizationEnvelope {
    Ok { result: OrderAuthorizationResult },
    Fault { fault: AuthorizationFault },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuthorizationHttpResponse {
    status: u16,
    body: AuthorizationEnvelope,
}

impl AuthorizationHttpResponse {
    pub fn success(result: OrderAuthorizationResult) -> Self {
        Self {
            status: http::StatusCode::OK.as_u16(),
            body: AuthorizationEnvelope::Ok { result },
        }
    }

    pub fn fault(fault: AuthorizationFault) -> Self {
        let status = match fault.code.as_str() {
            "order_id_invalid"
            | "idempotency_key_invalid"
            | "customer_id_invalid"
            | "payment_reference_invalid"
            | "items_invalid"
            | "amount_invalid"
            | "currency_invalid"
            | "request_json_invalid" => http::StatusCode::BAD_REQUEST,
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

    pub fn invalid_json(adapter_step: &str) -> Self {
        Self::fault(AuthorizationFault {
            code: "request_json_invalid".to_string(),
            failed_step: adapter_step.to_string(),
            message: "request body did not match the typed order contract".to_string(),
            order_id: String::new(),
            idempotency_key: String::new(),
            retryable: false,
            operator_action_required: false,
            compensations: Vec::new(),
        })
    }

    pub fn status(&self) -> http::StatusCode {
        match http::StatusCode::from_u16(self.status) {
            Ok(status) => status,
            Err(_) => http::StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn body(&self) -> &AuthorizationEnvelope {
        &self.body
    }

    pub fn into_parts(self) -> (http::StatusCode, AuthorizationEnvelope) {
        let status = match http::StatusCode::from_u16(self.status) {
            Ok(status) => status,
            Err(_) => http::StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, self.body)
    }
}

pub async fn execute_authorization(
    request: OrderAuthorizationRequest,
    resources: &OrderResources,
    bus: &mut Bus,
    adapter_step: &str,
) -> AuthorizationHttpResponse {
    let fallback_request = request.clone();
    match authorization_workflow()
        .execute(request, resources, bus)
        .await
    {
        Outcome::Next(result) => AuthorizationHttpResponse::success(result),
        Outcome::Fault(fault) => AuthorizationHttpResponse::fault(fault),
        Outcome::Branch(_, _) | Outcome::Jump(_, _) | Outcome::Emit(_, _) => {
            AuthorizationHttpResponse::fault(AuthorizationFault {
                code: "unexpected_domain_control_flow".to_string(),
                failed_step: adapter_step.to_string(),
                message: "domain workflow returned unsupported non-terminal control flow"
                    .to_string(),
                order_id: fallback_request.order_id,
                idempotency_key: fallback_request.idempotency_key,
                retryable: false,
                operator_action_required: true,
                compensations: Vec::new(),
            })
        }
    }
}
