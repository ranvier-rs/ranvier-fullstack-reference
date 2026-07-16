#!/usr/bin/env bash
set -euo pipefail
# build-all.sh — Build the Rust backend
#
# The default build resolves exact packages from the committed candidate
# registry. It never requires a sibling Ranvier checkout.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "╔══════════════════════════════════════╗"
echo "║  Ranvier Fullstack — Build All       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Backend (Rust, native release for local dev)
echo "[INFO] Building Rust backend (native release)…"
(cd "$SCRIPT_DIR/.." && node scripts/candidate-cargo.mjs build --manifest-path backend/Cargo.toml --locked --release)
echo "[OK] Backend: backend/target/release/ranvier-fullstack-backend"
echo ""

# Frontend (no build step needed)
echo "[INFO] Frontend is static HTML — no build step required."
echo ""
echo "[OK] Build complete! Run './scripts/deploy-local.sh' to start."
