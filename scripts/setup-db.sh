#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://ranvier:ranvierpass@localhost:5432/ranvier_db}"

echo "╔══════════════════════════════════════╗"
echo "║  Ranvier DB Setup                    ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "[INFO] Using the configured PostgreSQL connection (value redacted)."
echo ""

if ! command -v psql &>/dev/null; then
    echo "[WARN] psql not found. The backend auto-creates the schema on first start."
    exit 0
fi

echo "[INFO] Running schema bootstrap via psql…"
psql "$DATABASE_URL" <<'SQL'
CREATE TABLE IF NOT EXISTS order_authorization_decisions (
    decision_id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_digest TEXT NOT NULL,
    result JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS order_authorization_audit (
    audit_id BIGSERIAL PRIMARY KEY,
    decision_id TEXT NOT NULL UNIQUE REFERENCES order_authorization_decisions(decision_id),
    event JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
SQL

echo ""
echo "[OK] Order decision and audit schema ready."
