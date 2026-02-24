#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../backend"

echo "╔══════════════════════════════════════╗"
echo "║  Ranvier Fullstack — Build All       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Backend (Rust)
echo "[INFO] Building Rust backend (release)…"
(cd "$BACKEND_DIR" && cargo build --release)
echo "[OK] Backend: backend/target/release/ranvier-fullstack-backend"
echo ""

# Frontend
echo "[INFO] Frontend is static HTML — no build step required."
echo ""

echo "[OK] Build complete!"
echo "     Run './scripts/deploy-local.sh' to start the full stack."
