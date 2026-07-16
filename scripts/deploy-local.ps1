#!/usr/bin/env pwsh
# deploy-local.ps1 — Start the entire fullstack via Docker Compose

$ErrorActionPreference = "Stop"
$composeFile = Join-Path $PSScriptRoot "..\docker\compose\compose.dev.yml"

Write-Host "╔═══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║  Ranvier Fullstack Reference — Local Deploy   ║" -ForegroundColor Cyan
Write-Host "╚═══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# Detect compose command
$composeCmd = if (Get-Command "docker-compose" -ErrorAction SilentlyContinue) { "docker-compose" }
              elseif (Get-Command "podman-compose" -ErrorAction SilentlyContinue) { "podman-compose" }
              elseif (Get-Command "docker" -ErrorAction SilentlyContinue) { "docker compose" }
              elseif (Get-Command "podman" -ErrorAction SilentlyContinue) { "podman compose" }
              else { throw "No supported Docker or Podman Compose command found" }

Write-Host "[INFO] Using: $composeCmd" -ForegroundColor Green
Write-Host "[INFO] Compose file: $composeFile"
Write-Host ""

# Copy .env if missing
$envFile = Join-Path $PSScriptRoot "..\.env"
$envExample = Join-Path $PSScriptRoot "..\.env.example"
if (-not (Test-Path $envFile)) {
    Copy-Item $envExample $envFile
    Write-Host "[INFO] Created .env from .env.example" -ForegroundColor Yellow
}

# Start everything
Write-Host "[INFO] Starting services..." -ForegroundColor Cyan
if ($composeCmd -eq "docker compose") {
    docker compose -f $composeFile up --build -d
} elseif ($composeCmd -eq "podman compose") {
    podman compose -f $composeFile up --build -d
} else {
    & $composeCmd -f $composeFile up --build -d
}

Write-Host ""
Write-Host "[OK] Services started!" -ForegroundColor Green
Write-Host "  Frontend:  http://localhost:8080"
Write-Host "  API:       http://localhost:8080/api/order-authorizations"
Write-Host "  DB:        localhost:5432 (ranvier/ranvierpass)"
