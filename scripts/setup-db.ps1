#!/usr/bin/env pwsh
# setup-db.ps1 — Initialise the PostgreSQL database for the fullstack reference

$ErrorActionPreference = "Stop"
$DatabaseUrl = if ($env:DATABASE_URL) { $env:DATABASE_URL } else {
    "postgres://ranvier:ranvierpass@localhost:5432/ranvier_db"
}

Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Ranvier DB Setup                    ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "[INFO] Using the configured PostgreSQL connection (value redacted)." -ForegroundColor DarkGray
Write-Host ""

# Check psql is available
if (-not (Get-Command "psql" -ErrorAction SilentlyContinue)) {
    Write-Host "[WARN] psql not found. The backend auto-creates the schema on first start." -ForegroundColor Yellow
    Write-Host "       To run migrations manually, install the PostgreSQL client tools."
    exit 0
}

Write-Host "[INFO] Running schema bootstrap via psql…" -ForegroundColor Cyan
$sql = @"
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
"@

$sql | psql $DatabaseUrl

Write-Host ""
Write-Host "[OK] Order decision and audit schema ready." -ForegroundColor Green
