#!/usr/bin/env pwsh
# build-all.ps1 — Build the Rust backend in release mode

$ErrorActionPreference = "Stop"
$BackendDir = Join-Path $PSScriptRoot "..\\backend"

Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Ranvier Fullstack — Build All       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Backend (Rust) ──────────────────────────────────────────
Write-Host "[INFO] Building Rust backend (release)…" -ForegroundColor Cyan
Push-Location $BackendDir
cargo build --release
Pop-Location
Write-Host "[OK] Backend binary: backend/target/release/ranvier-fullstack-backend" -ForegroundColor Green
Write-Host ""

# ── Frontend ────────────────────────────────────────────────
Write-Host "[INFO] Frontend is static HTML — no build step required." -ForegroundColor DarkGray
Write-Host ""

Write-Host "[OK] Build complete!" -ForegroundColor Green
Write-Host "     Run './scripts/deploy-local.ps1' to start the full stack."
