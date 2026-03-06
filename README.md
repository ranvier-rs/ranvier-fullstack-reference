# Ranvier Fullstack Reference

A production-like reference architecture demonstrating **Ranvier v0.18.0** in a real full-stack deployment topology.

## Architecture

```
┌─────────────────┐
│   Browser :8080  │
└────────┬────────┘
         │
  ┌──────▼──────┐
  │  Nginx Proxy │  ← serves static SPA + proxies /api
  └──┬───────┬──┘
     │       │
┌────▼───┐ ┌─▼────────────┐
│Frontend│ │ Ranvier API  │  ← :3000 /api/*
│(static)│ │ (Rust/Axon)  │
└────────┘ └──────┬───────┘
                  │
           ┌──────▼──────┐
           │ PostgreSQL   │  ← :5432
           └─────────────┘
```

## Quick Start

```bash
# 1. Clone this repo
# 2. Deploy locally (requires Docker or Podman)
pwsh scripts/deploy-local.ps1    # Windows
bash scripts/deploy-local.sh     # Linux/macOS

# 3. Open http://localhost:8080
```

## Structure

```
├── backend/           # Ranvier v0.18 HTTP API (Rust)
├── frontend/          # Static SPA (HTML/CSS/JS)
├── docker/
│   ├── compose/       # compose.dev.yml
│   ├── backend.Dockerfile
│   ├── frontend.Dockerfile
│   └── nginx.conf
├── scripts/           # deploy-local, setup-db, build-all
├── .env.example
└── README.md
```

## Endpoints

| Method | Path          | Description                |
|--------|---------------|----------------------------|
| GET    | `/api/health` | Health check               |
| GET    | `/api/notes`  | List notes (mock)          |
| POST   | `/api/notes`  | Create note (mock)         |

## Design Decisions

- **Reverse proxy pattern** (Discussion 223 §4.1): Nginx serves the static frontend and proxies `/api` to the Ranvier backend. This aligns with the principle that `Ranvier::http()` is an **Ingress Builder**, not a web server.
- **Separate containers**: Backend, frontend, and DB each run in their own container for clear deployment boundaries.
- **Path dependencies**: The backend `Cargo.toml` uses `path = "../../ranvier/..."` to link directly to the local workspace crates during development.

## Related Documents

- [`docs/discussion/223_fullstack_sample_repo_strategy.md`](../docs/discussion/223_fullstack_sample_repo_strategy.md) — Strategy for this reference repo
- [`docs/00_roadmap/milestone_parallel.md`](../docs/00_roadmap/milestone_parallel.md) — M141 milestone tracking
