#!/usr/bin/env bash
set -euo pipefail

DATABASE_URL="${DATABASE_URL:-postgres://ranvier:ranvierpass@localhost:5432/ranvier_db}"

echo "╔══════════════════════════════════════╗"
echo "║  Ranvier DB Setup                    ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "[INFO] DATABASE_URL: $DATABASE_URL"
echo ""

if ! command -v psql &>/dev/null; then
    echo "[WARN] psql not found. The backend auto-creates the schema on first start."
    exit 0
fi

echo "[INFO] Running schema bootstrap via psql…"
psql "$DATABASE_URL" <<'SQL'
CREATE TABLE IF NOT EXISTS notes (
    id    SERIAL PRIMARY KEY,
    title VARCHAR NOT NULL,
    body  TEXT    NOT NULL
);
INSERT INTO notes (title, body) VALUES
    ('Welcome',          'Ranvier fullstack reference is running!'),
    ('Architecture',     'Reverse proxy → SPA + /api → Ranvier backend'),
    ('v0.10.0 Released', 'All gates passed. Typed Decision Engine is stable.')
ON CONFLICT DO NOTHING;
SQL

echo ""
echo "[OK] Schema ready and seed data inserted."
