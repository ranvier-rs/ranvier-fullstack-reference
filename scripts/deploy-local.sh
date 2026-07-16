#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../docker/compose/compose.dev.yml"

echo "╔═══════════════════════════════════════════════╗"
echo "║  Ranvier Fullstack Reference — Local Deploy   ║"
echo "╚═══════════════════════════════════════════════╝"
echo ""

# Detect compose command
if command -v docker-compose &>/dev/null; then
    COMPOSE_CMD="docker-compose"
elif command -v podman-compose &>/dev/null; then
    COMPOSE_CMD="podman-compose"
elif docker compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
elif podman compose version &>/dev/null 2>&1; then
    COMPOSE_CMD="podman compose"
else
    echo "[ERROR] No supported Docker or Podman Compose command found"
    exit 1
fi

echo "[INFO] Using: $COMPOSE_CMD"
echo "[INFO] Compose file: $COMPOSE_FILE"
echo ""

# Copy .env if missing
ENV_FILE="$SCRIPT_DIR/../.env"
if [ ! -f "$ENV_FILE" ]; then
    cp "$SCRIPT_DIR/../.env.example" "$ENV_FILE"
    echo "[INFO] Created .env from .env.example"
fi

# Start everything
echo "[INFO] Starting services..."
$COMPOSE_CMD -f "$COMPOSE_FILE" up --build -d

echo ""
echo "[OK] Services started!"
echo "  Frontend:  http://localhost:8080"
echo "  API:       http://localhost:8080/api/order-authorizations"
echo "  DB:        localhost:5432 (ranvier/ranvierpass)"
