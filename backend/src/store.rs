use std::collections::BTreeMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::domain::{AuditRecord, OrderAuthorizationResult};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StoredDecision {
    pub decision_id: String,
    pub order_id: String,
    pub idempotency_key: String,
    pub request_digest: String,
    pub result: OrderAuthorizationResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordMode {
    Normal,
    DefiniteFailure,
    LoseCommitAcknowledgement,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordStatus {
    Inserted,
    Existing(StoredDecision),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailureCertainty {
    DefiniteNoCommit,
    CommitUnknown,
}

#[derive(Debug, Clone)]
pub struct StoreFailure {
    pub code: &'static str,
    pub certainty: FailureCertainty,
}

impl StoreFailure {
    fn definite(code: &'static str) -> Self {
        Self {
            code,
            certainty: FailureCertainty::DefiniteNoCommit,
        }
    }

    fn unknown(code: &'static str) -> Self {
        Self {
            code,
            certainty: FailureCertainty::CommitUnknown,
        }
    }
}

#[async_trait]
pub trait DecisionStore: Send + Sync {
    async fn find(&self, idempotency_key: &str) -> Result<Option<StoredDecision>, StoreFailure>;

    async fn record(
        &self,
        decision: StoredDecision,
        audit: AuditRecord,
        mode: RecordMode,
    ) -> Result<RecordStatus, StoreFailure>;

    async fn decisions(&self) -> Result<Vec<StoredDecision>, StoreFailure>;

    async fn audits(&self) -> Result<Vec<AuditRecord>, StoreFailure>;
}

#[derive(Default)]
struct MemoryState {
    decisions: BTreeMap<String, StoredDecision>,
    audits: Vec<AuditRecord>,
}

#[derive(Clone, Default)]
pub struct InMemoryDecisionStore {
    state: Arc<RwLock<MemoryState>>,
}

impl InMemoryDecisionStore {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl DecisionStore for InMemoryDecisionStore {
    async fn find(&self, idempotency_key: &str) -> Result<Option<StoredDecision>, StoreFailure> {
        Ok(self
            .state
            .read()
            .await
            .decisions
            .get(idempotency_key)
            .cloned())
    }

    async fn record(
        &self,
        decision: StoredDecision,
        audit: AuditRecord,
        mode: RecordMode,
    ) -> Result<RecordStatus, StoreFailure> {
        if mode == RecordMode::DefiniteFailure {
            return Err(StoreFailure::definite("decision_write_failed"));
        }

        let mut state = self.state.write().await;
        if let Some(existing) = state.decisions.get(&decision.idempotency_key) {
            return Ok(RecordStatus::Existing(existing.clone()));
        }

        state
            .decisions
            .insert(decision.idempotency_key.clone(), decision);
        state.audits.push(audit);
        drop(state);

        if mode == RecordMode::LoseCommitAcknowledgement {
            Err(StoreFailure::unknown("decision_commit_ack_lost"))
        } else {
            Ok(RecordStatus::Inserted)
        }
    }

    async fn decisions(&self) -> Result<Vec<StoredDecision>, StoreFailure> {
        Ok(self
            .state
            .read()
            .await
            .decisions
            .values()
            .cloned()
            .collect())
    }

    async fn audits(&self) -> Result<Vec<AuditRecord>, StoreFailure> {
        Ok(self.state.read().await.audits.clone())
    }
}

#[derive(Clone)]
pub struct PgDecisionStore {
    pool: sqlx::PgPool,
}

#[derive(sqlx::FromRow)]
struct DecisionRow {
    decision_id: String,
    order_id: String,
    idempotency_key: String,
    request_digest: String,
    result: serde_json::Value,
}

impl TryFrom<DecisionRow> for StoredDecision {
    type Error = StoreFailure;

    fn try_from(row: DecisionRow) -> Result<Self, Self::Error> {
        let result = serde_json::from_value(row.result)
            .map_err(|_| StoreFailure::unknown("stored_decision_invalid"))?;
        Ok(Self {
            decision_id: row.decision_id,
            order_id: row.order_id,
            idempotency_key: row.idempotency_key,
            request_digest: row.request_digest,
            result,
        })
    }
}

impl PgDecisionStore {
    pub async fn initialize(pool: sqlx::PgPool) -> Result<Self, StoreFailure> {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS order_authorization_decisions (
                decision_id TEXT PRIMARY KEY,
                order_id TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                request_digest TEXT NOT NULL,
                result JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pool)
        .await
        .map_err(|_| StoreFailure::definite("decision_schema_failed"))?;

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS order_authorization_audit (
                audit_id BIGSERIAL PRIMARY KEY,
                decision_id TEXT NOT NULL UNIQUE REFERENCES order_authorization_decisions(decision_id),
                event JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )",
        )
        .execute(&pool)
        .await
        .map_err(|_| StoreFailure::definite("audit_schema_failed"))?;

        Ok(Self { pool })
    }

    async fn find_with_executor<'e, E>(
        executor: E,
        idempotency_key: &str,
    ) -> Result<Option<StoredDecision>, StoreFailure>
    where
        E: sqlx::Executor<'e, Database = sqlx::Postgres>,
    {
        let row = sqlx::query_as::<_, DecisionRow>(
            "SELECT decision_id, order_id, idempotency_key, request_digest, result
             FROM order_authorization_decisions WHERE idempotency_key = $1",
        )
        .bind(idempotency_key)
        .fetch_optional(executor)
        .await
        .map_err(|_| StoreFailure::unknown("decision_lookup_failed"))?;

        row.map(TryInto::try_into).transpose()
    }
}

#[async_trait]
impl DecisionStore for PgDecisionStore {
    async fn find(&self, idempotency_key: &str) -> Result<Option<StoredDecision>, StoreFailure> {
        Self::find_with_executor(&self.pool, idempotency_key).await
    }

    async fn record(
        &self,
        decision: StoredDecision,
        audit: AuditRecord,
        mode: RecordMode,
    ) -> Result<RecordStatus, StoreFailure> {
        if mode == RecordMode::DefiniteFailure {
            return Err(StoreFailure::definite("decision_write_failed"));
        }

        let result_json = serde_json::to_value(&decision.result)
            .map_err(|_| StoreFailure::definite("decision_serialize_failed"))?;
        let audit_json = serde_json::to_value(&audit)
            .map_err(|_| StoreFailure::definite("audit_serialize_failed"))?;
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| StoreFailure::definite("decision_transaction_begin_failed"))?;

        let inserted = sqlx::query(
            "INSERT INTO order_authorization_decisions
             (decision_id, order_id, idempotency_key, request_digest, result)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (idempotency_key) DO NOTHING",
        )
        .bind(&decision.decision_id)
        .bind(&decision.order_id)
        .bind(&decision.idempotency_key)
        .bind(&decision.request_digest)
        .bind(result_json)
        .execute(&mut *transaction)
        .await
        .map_err(|_| StoreFailure::definite("decision_insert_failed"))?
        .rows_affected()
            == 1;

        if !inserted {
            let existing = Self::find_with_executor(&mut *transaction, &decision.idempotency_key)
                .await?
                .ok_or_else(|| StoreFailure::unknown("decision_conflict_unresolved"))?;
            transaction
                .rollback()
                .await
                .map_err(|_| StoreFailure::unknown("decision_rollback_failed"))?;
            return Ok(RecordStatus::Existing(existing));
        }

        sqlx::query("INSERT INTO order_authorization_audit (decision_id, event) VALUES ($1, $2)")
            .bind(&decision.decision_id)
            .bind(audit_json)
            .execute(&mut *transaction)
            .await
            .map_err(|_| StoreFailure::definite("audit_insert_failed"))?;

        transaction
            .commit()
            .await
            .map_err(|_| StoreFailure::unknown("decision_commit_unknown"))?;

        if mode == RecordMode::LoseCommitAcknowledgement {
            Err(StoreFailure::unknown("decision_commit_ack_lost"))
        } else {
            Ok(RecordStatus::Inserted)
        }
    }

    async fn decisions(&self) -> Result<Vec<StoredDecision>, StoreFailure> {
        let rows = sqlx::query_as::<_, DecisionRow>(
            "SELECT decision_id, order_id, idempotency_key, request_digest, result
             FROM order_authorization_decisions ORDER BY idempotency_key",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreFailure::unknown("decision_evidence_read_failed"))?;
        rows.into_iter().map(TryInto::try_into).collect()
    }

    async fn audits(&self) -> Result<Vec<AuditRecord>, StoreFailure> {
        let rows: Vec<(serde_json::Value,)> =
            sqlx::query_as("SELECT event FROM order_authorization_audit ORDER BY audit_id")
                .fetch_all(&self.pool)
                .await
                .map_err(|_| StoreFailure::unknown("audit_evidence_read_failed"))?;

        rows.into_iter()
            .map(|(value,)| {
                serde_json::from_value(value)
                    .map_err(|_| StoreFailure::unknown("stored_audit_invalid"))
            })
            .collect()
    }
}
