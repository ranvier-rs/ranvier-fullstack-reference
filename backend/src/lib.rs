//! Canonical order-authorization domain and native Ranvier HTTP adapter.
//!
//! The application-owned workflow in [`domain`] is the only business workflow.
//! HTTP adapters translate its typed terminal result or structured fault; they
//! do not duplicate policy, idempotency, persistence, or compensation rules.

pub mod domain;
pub mod http_contract;
pub mod hybrid;
pub mod native;
mod startup;
pub mod store;

pub use domain::{
    AuthorizationFault, EvidenceSnapshot, Fixture, OrderAuthorizationRequest,
    OrderAuthorizationResult, OrderItem, OrderResources, authorization_workflow,
};
pub use http_contract::{AuthorizationEnvelope, AuthorizationHttpResponse, execute_authorization};
pub use hybrid::{build_hybrid_router, run_hybrid_from_env, serve_hybrid_with_shutdown};
pub use native::{build_native_ingress, run_native_from_env};
pub use store::{DecisionStore, InMemoryDecisionStore, PgDecisionStore};
