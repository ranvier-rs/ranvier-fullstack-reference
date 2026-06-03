/*!
# Ranvier Fullstack Reference — Backend API (v0.51)

Demonstrates a production-like Notes CRUD API built with current Ranvier features:

- **`get_json_out`**: Auto-serialize typed Outcome as JSON at route boundary
- **`post_typed_json_out`**: Typed JSON input + typed JSON output (JsonSchema)
- **`try_outcome!`**: Ergonomic `Result → Outcome::Fault` conversion
- **`Bus::get_cloned()`**: Concise resource extraction from Bus
- **`CorsGuard::permissive()`**: One-line dev CORS

## Endpoints

- `GET  /api/health` — Health check (typed JSON response)
- `GET  /api/notes`  — List all notes (PostgreSQL → typed JSON)
- `POST /api/notes`  — Create a note (typed JSON input → typed JSON output)

## Running

```bash
DATABASE_URL=postgres://ranvier:ranvierpass@localhost:5432/ranvier_db cargo run
```
*/

use async_trait::async_trait;
use ranvier_core::{prelude::*, try_outcome};
use ranvier_guard::prelude::*;
use ranvier_http::prelude::*;
use ranvier_runtime::Axon;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// ─── Models ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Note {
    pub id: i32,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct CreateNoteInput {
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
}

// ─── Transitions ──────────────────────────────────────────────

#[derive(Clone, Copy)]
struct HealthCheck;

#[async_trait]
impl Transition<(), HealthResponse> for HealthCheck {
    type Error = String;
    type Resources = ();

    async fn run(
        &self,
        _input: (),
        _res: &Self::Resources,
        _bus: &mut Bus,
    ) -> Outcome<HealthResponse, Self::Error> {
        Outcome::Next(HealthResponse {
            status: "ok".into(),
            version: "0.51.0".into(),
        })
    }
}

#[derive(Clone, Copy)]
struct ListNotes;

#[async_trait]
impl Transition<(), Vec<Note>> for ListNotes {
    type Error = String;
    type Resources = ();

    async fn run(
        &self,
        _input: (),
        _res: &Self::Resources,
        bus: &mut Bus,
    ) -> Outcome<Vec<Note>, Self::Error> {
        let pool = try_outcome!(bus.get_cloned::<sqlx::PgPool>(), "PgPool not in Bus");
        let notes = try_outcome!(
            sqlx::query_as::<_, Note>("SELECT id, title, body FROM notes ORDER BY id")
                .fetch_all(&pool)
                .await
                .map_err(|e| e.to_string())
        );
        Outcome::Next(notes)
    }
}

#[derive(Clone, Copy)]
struct CreateNote;

#[async_trait]
impl Transition<CreateNoteInput, Note> for CreateNote {
    type Error = String;
    type Resources = ();

    async fn run(
        &self,
        input: CreateNoteInput,
        _res: &Self::Resources,
        bus: &mut Bus,
    ) -> Outcome<Note, Self::Error> {
        let pool = try_outcome!(bus.get_cloned::<sqlx::PgPool>(), "PgPool not in Bus");
        let note = try_outcome!(
            sqlx::query_as::<_, Note>(
                "INSERT INTO notes (title, body) VALUES ($1, $2) RETURNING id, title, body",
            )
            .bind(&input.title)
            .bind(&input.body)
            .fetch_one(&pool)
            .await
            .map_err(|e| e.to_string())
        );
        Outcome::Next(note)
    }
}

// ─── Main ──────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://ranvier:ranvierpass@localhost:5432/ranvier_db".into());

    tracing::info!("Connecting to configured PostgreSQL database");

    // Retry loop handles container startup race condition
    let pool = {
        let mut result = None;
        for i in 1..=10 {
            match sqlx::PgPool::connect(&database_url).await {
                Ok(p) => {
                    result = Some(p);
                    break;
                }
                Err(e) => {
                    tracing::warn!("DB attempt {i}: {e}. Retrying in 2s…");
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                }
            }
        }
        result.ok_or_else(|| {
            std::io::Error::other("failed to connect to database after 10 attempts")
        })?
    };

    // Bootstrap schema (idempotent)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notes (
            id    SERIAL PRIMARY KEY,
            title VARCHAR NOT NULL,
            body  TEXT    NOT NULL
        )",
    )
    .execute(&pool)
    .await?;

    // Build circuits — typed Outcome, no manual JSON serialization
    let health = Axon::simple::<String>("health").then(HealthCheck);

    let list = Axon::simple::<String>("list-notes").then(ListNotes);

    let create = Axon::typed::<CreateNoteInput, String>("create-note").then(CreateNote);

    println!("╔═══════════════════════════════════════════════╗");
    println!("║  Ranvier Fullstack Reference — Backend API    ║");
    println!("║  v0.51 · http://0.0.0.0:3000                 ║");
    println!("╚═══════════════════════════════════════════════╝");

    Ranvier::http()
        .bind("0.0.0.0:3000")
        .bus_injector({
            let pool = pool.clone();
            move |_parts, bus| {
                bus.insert(pool.clone());
            }
        })
        .guard(AccessLogGuard::<()>::new())
        .guard(CorsGuard::<()>::permissive())
        // Routes: typed JSON auto-serialization at the HTTP boundary
        .get_json_out("/api/health", health)
        .get_json_out("/api/notes", list)
        .post_typed_json_out("/api/notes", create)
        .run(())
        .await
}
