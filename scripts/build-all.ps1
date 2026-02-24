#!/usr/bin/env pwsh
# build-all.ps1 — Build the Rust backend
#
# musl cross-compilation note:
#   Direct Windows → musl cross-compile requires x86_64-linux-musl-gcc (not available natively).
#   The production Docker image (docker/backend.Dockerfile) uses 'clux/muslrust' inside the builder
#   stage to produce the fully-static binary. Run './scripts/deploy-local.ps1' to trigger that build.
#
#   For development iteration on Windows, the normal release build (non-musl) is used here.

$ErrorActionPreference = "Stop"
$BackendDir = Join-Path $PSScriptRoot "..\backend"

Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Ranvier Fullstack — Build All       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Backend (Rust, native release for local dev) ───────────
Write-Host "[INFO] Building Rust backend (native release)…" -ForegroundColor Cyan
Push-Location $BackendDir
cargo build --release
Pop-Location
Write-Host "[OK] Backend binary: backend/target/release/ranvier-fullstack-backend" -ForegroundColor Green
Write-Host ""

# ── musl via Docker ────────────────────────────────────────
Write-Host "[INFO] For a musl static binary (prod), the Docker build handles this automatically." -ForegroundColor DarkGray
Write-Host "       Run './scripts/deploy-local.ps1' to build the full stack with musl + scratch image."
Write-Host ""

# ── Frontend ────────────────────────────────────────────────
Write-Host "[INFO] Frontend is static HTML — no build step required." -ForegroundColor DarkGray
Write-Host ""

Write-Host "[OK] Build complete!" -ForegroundColor Green
