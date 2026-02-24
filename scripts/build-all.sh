#!/usr/bin/env bash
set -euo pipefail
# build-all.sh — Build the Rust backend
#
# musl cross-compilation note:
#   On Linux, you can build a musl binary directly:
#     rustup target add x86_64-unknown-linux-musl
#     cargo build --release --target x86_64-unknown-linux-musl
#   On macOS/Windows, the Docker build (clux/muslrust) handles this automatically.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/../backend"

echo "╔══════════════════════════════════════╗"
echo "║  Ranvier Fullstack — Build All       ║"
echo "╚══════════════════════════════════════╝"
echo ""

# Backend (Rust, native release for local dev)
echo "[INFO] Building Rust backend (native release)…"
(cd "$BACKEND_DIR" && cargo build --release)
echo "[OK] Backend: backend/target/release/ranvier-fullstack-backend"
echo ""

# Optional: musl build directly (Linux only)
if [[ "${MUSL:-0}" == "1" ]]; then
    echo "[INFO] Building musl static binary…"
    rustup target add x86_64-unknown-linux-musl 2>/dev/null || true
    (cd "$BACKEND_DIR" && cargo build --release --target x86_64-unknown-linux-musl)
    echo "[OK] musl binary: backend/target/x86_64-unknown-linux-musl/release/ranvier-fullstack-backend"
fi

# Frontend (no build step needed)
echo "[INFO] Frontend is static HTML — no build step required."
echo ""
echo "[OK] Build complete! Run './scripts/deploy-local.sh' to start."
