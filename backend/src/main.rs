/*!
# Ranvier Fullstack Reference — Backend API

Demonstrates a multi-route Ranvier HTTP backend suitable for
pairing with a static frontend served through a reverse proxy.

## Endpoints

- `GET  /api/notes`  — List all notes (mock)
- `POST /api/notes`  — Create a note (mock)
- `GET  /api/health` — Health check

## Running

```bash
cargo run
# API available at http://127.0.0.1:3000/api/health
```
*/

use anyhow::Result;
use ranvier_core::prelude::*;
use ranvier_http::prelude::*;
use ranvier_macros::transition;
use ranvier_runtime::Axon;
use serde::{Deserialize, Serialize};

// ─── Models ────────────────────────────────────────────────────

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Note {
    pub id: i32,
    pub title: String,
    pub body: String,
}

// ─── Transitions ───────────────────────────────────────────────

#[transition]
async fn health_check(
    _state: (),
    _resources: &(),
    _bus: &mut Bus,
) -> Outcome<String, anyhow::Error> {
    Outcome::Next(r#"{"status":"ok","version":"0.10.0"}"#.to_string())
}

#[transition]
async fn list_notes(
    _state: (),
    _resources: &(),
    _bus: &mut Bus,
) -> Outcome<String, anyhow::Error> {
    let notes = vec![
        Note { id: 1, title: "Welcome".into(),        body: "Ranvier fullstack reference is running!".into() },
        Note { id: 2, title: "Architecture".into(),    body: "Reverse proxy → static SPA + /api → Ranvier backend".into() },
        Note { id: 3, title: "v0.10.0 Released".into(), body: "All gates passed. Typed Decision Engine is stable.".into() },
    ];
    let json = serde_json::to_string(&notes).unwrap();
    Outcome::Next(json)
}

#[transition]
async fn create_note(
    _state: (),
    _resources: &(),
    _bus: &mut Bus,
) -> Outcome<String, anyhow::Error> {
    // In a real app this would parse the request body and persist to DB.
    let note = Note { id: 4, title: "New Note".into(), body: "Created via POST".into() };
    let json = serde_json::to_string(&note).unwrap();
    Outcome::Next(json)
}

// ─── Main ──────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let health = Axon::<(), (), anyhow::Error>::new("HealthCheck")
        .then(health_check);
    let list   = Axon::<(), (), anyhow::Error>::new("ListNotes")
        .then(list_notes);
    let create = Axon::<(), (), anyhow::Error>::new("CreateNote")
        .then(create_note);

    println!("╔═══════════════════════════════════════════════╗");
    println!("║  Ranvier Fullstack Reference — Backend API    ║");
    println!("║  Listening on http://0.0.0.0:3000             ║");
    println!("╚═══════════════════════════════════════════════╝");

    Ranvier::http()
        .bind("0.0.0.0:3000")
        .get("/api/health", health)
        .get("/api/notes",  list)
        .post("/api/notes", create)
        .run(())
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?;

    Ok(())
}
