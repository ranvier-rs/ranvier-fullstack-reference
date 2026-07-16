#!/usr/bin/env pwsh
# build-all.ps1 — Build the Rust backend
#
# The default build resolves exact packages from the committed candidate
# registry. It never requires a sibling Ranvier checkout.

$ErrorActionPreference = "Stop"

Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Ranvier Fullstack — Build All       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Backend (Rust, native release for local dev) ───────────
Write-Host "[INFO] Building Rust backend (native release)…" -ForegroundColor Cyan
node (Join-Path $PSScriptRoot "candidate-cargo.mjs") build --manifest-path backend/Cargo.toml --locked --release
Write-Host "[OK] Backend binary: backend/target/release/ranvier-fullstack-backend" -ForegroundColor Green
Write-Host ""

# ── Container build ─────────────────────────────────────────
Write-Host "[INFO] The pinned container build uses the same committed candidate registry." -ForegroundColor DarkGray
Write-Host "       Run './scripts/deploy-local.ps1' to build the full stack."
Write-Host ""

# ── Frontend ────────────────────────────────────────────────
Write-Host "[INFO] Frontend is static HTML — no build step required." -ForegroundColor DarkGray
Write-Host ""

Write-Host "[OK] Build complete!" -ForegroundColor Green
