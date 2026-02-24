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
Write-Host "[INFO] DATABASE_URL: $DatabaseUrl" -ForegroundColor DarkGray
Write-Host ""

# Check psql is available
if (-not (Get-Command "psql" -ErrorAction SilentlyContinue)) {
    Write-Host "[WARN] psql not found. The backend auto-creates the schema on first start." -ForegroundColor Yellow
    Write-Host "       To run migrations manually, install the PostgreSQL client tools."
    exit 0
}

Write-Host "[INFO] Running schema bootstrap via psql…" -ForegroundColor Cyan
$sql = @"
CREATE TABLE IF NOT EXISTS notes (
    id    SERIAL PRIMARY KEY,
    title VARCHAR NOT NULL,
    body  TEXT    NOT NULL
);
INSERT INTO notes (title, body) VALUES
    ('Welcome', 'Ranvier fullstack reference is running!'),
    ('Architecture', 'Reverse proxy → SPA + /api → Ranvier backend'),
    ('v0.10.0 Released', 'All gates passed. Typed Decision Engine is stable.')
ON CONFLICT DO NOTHING;
"@

$sql | psql $DatabaseUrl

Write-Host ""
Write-Host "[OK] Schema ready and seed data inserted." -ForegroundColor Green
