//! Canonical order-authorization domain and native Ranvier HTTP adapter.
//!
//! The application-owned workflow in [`domain`] is the only business workflow.
//! HTTP adapters translate its typed terminal result or structured fault; they
//! do not duplicate policy, idempotency, persistence, or compensation rules.

pub mod domain;
pub mod native;
pub mod store;

pub use domain::{
    AuthorizationFault, EvidenceSnapshot, Fixture, OrderAuthorizationRequest,
    OrderAuthorizationResult, OrderItem, OrderResources, authorization_workflow,
};
pub use native::{build_native_ingress, run_native_from_env};
pub use store::{DecisionStore, InMemoryDecisionStore, PgDecisionStore};
