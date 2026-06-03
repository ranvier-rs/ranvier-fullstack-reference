# Ranvier Fullstack Reference

A production-like reference architecture demonstrating **Ranvier v0.51.0** in a real full-stack deployment topology.

## Feature Showcase

- **`get_json_out`** / **`post_typed_json_out`**: Auto-serialize typed Outcome as JSON at route boundary
- **`try_outcome!`**: Ergonomic `Result → Outcome::Fault` conversion
- **`Bus::get_cloned()`**: Concise resource extraction
- **`CorsGuard::permissive()`**: One-line dev CORS
- **Typed Transitions**: Return domain structs, not `String` — serialization is infrastructure

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
├── backend/           # Ranvier HTTP API (Rust)
├── frontend/          # Static SPA (HTML/CSS/JS)
├── docker/
│   ├── compose/       # compose.dev.yml, compose.prod.yml
│   ├── backend.Dockerfile
│   ├── frontend.Dockerfile
│   └── nginx.conf
├── scripts/           # deploy-local, setup-db, build-all
├── .env.example
└── README.md
```

## Endpoints

| Method | Path          | Description                    |
|--------|---------------|--------------------------------|
| GET    | `/api/health` | Health check (typed JSON)      |
| GET    | `/api/notes`  | List notes (PostgreSQL → JSON) |
| POST   | `/api/notes`  | Create note (typed input/output) |

## Design Decisions

- **Reverse proxy pattern**: Nginx serves the static frontend and proxies `/api` to the Ranvier backend. `Ranvier::http()` is an **Ingress Builder**, not a web server.
- **Separate containers**: Backend, frontend, and DB each run in their own container for clear deployment boundaries.
- **Path dependencies**: The backend `Cargo.toml` uses `path = "../../ranvier/..."` for local workspace parity.
- **Typed JSON serialization at boundary**: Transitions return domain structs (`Note`, `HealthResponse`). JSON serialization happens at the route level via `get_json_out` / `post_typed_json_out`, aligning with PHILOSOPHY.md §5 "Infrastructure as Boundary".
