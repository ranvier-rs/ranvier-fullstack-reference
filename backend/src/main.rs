/*!
# Ranvier Fullstack Reference — Backend API

Demonstrates the `DbTransition` + `PgNode` + `DbResources` pattern from `ranvier-db`
wired into a multi-route Ranvier HTTP ingress.

## Endpoints

- `GET  /api/health` — Health check
- `GET  /api/notes`  — List all notes (PostgreSQL)
- `POST /api/notes`  — Create a note (PostgreSQL)

## Running

```bash
DATABASE_URL=postgres://ranvier:ranvierpass@localhost:5432/ranvier_db cargo run
```
*/

use async_trait::async_trait;
use ranvier_core::{prelude::*, transition::ResourceRequirement};
use ranvier_db::{
    node::{DbResources, DbTransition, PgNode, QueryResult},
    prelude::{DbError, PostgresPool},
};
use ranvier_http::prelude::*;
use ranvier_runtime::Axon;
use serde::{Deserialize, Serialize};

// ─── Models ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Note {
    pub id: i32,
    pub title: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateNoteInput {
    pub title: String,
    pub body: String,
}

// ─── Resources ─────────────────────────────────────────────────

#[derive(Clone)]
struct AppResources {
    pool: PostgresPool,
}

impl ResourceRequirement for AppResources {}

impl DbResources for AppResources {
    fn pg_pool(&self) -> &sqlx::PgPool {
        self.pool.inner()
    }
}

// ─── DB Transitions ────────────────────────────────────────────

#[derive(Clone, Copy)]
struct ListNotes;

#[async_trait]
impl DbTransition<(), Vec<Note>> for ListNotes {
    type Error = anyhow::Error;

    async fn run(&self, _input: (), pool: &sqlx::PgPool) -> QueryResult<Vec<Note>> {
        sqlx::query_as::<_, Note>("SELECT id, title, body FROM notes ORDER BY id")
            .fetch_all(pool)
            .await
            .map_err(|e| DbError::QueryFailed(e.to_string()))
    }
}

/// Parses the CreateNoteInput JSON from the bus raw body bytes.
#[derive(Clone, Copy)]
struct ParseBody;

#[async_trait]
impl Transition<(), CreateNoteInput> for ParseBody {
    type Error = anyhow::Error;
    type Resources = AppResources;

    async fn run(
        &self,
        _state: (),
        _res: &Self::Resources,
        bus: &mut Bus,
    ) -> Outcome<CreateNoteInput, Self::Error> {
        // The HTTP layer stores the raw body bytes on the bus as Vec<u8>
        match bus.read::<Vec<u8>>() {
            Some(bytes) => match serde_json::from_slice::<CreateNoteInput>(bytes) {
                Ok(payload) => Outcome::Next(payload),
                Err(e) => Outcome::Fault(anyhow::anyhow!("invalid JSON: {}", e)),
            },
            None => Outcome::Fault(anyhow::anyhow!("missing request body")),
        }
    }
}

#[derive(Clone, Copy)]
struct CreateNote;

#[async_trait]
impl DbTransition<CreateNoteInput, Note> for CreateNote {
    type Error = anyhow::Error;

    async fn run(&self, input: CreateNoteInput, pool: &sqlx::PgPool) -> QueryResult<Note> {
        sqlx::query_as::<_, Note>(
            "INSERT INTO notes (title, body) VALUES ($1, $2) RETURNING id, title, body",
        )
        .bind(&input.title)
        .bind(&input.body)
        .fetch_one(pool)
        .await
        .map_err(|e| DbError::QueryFailed(e.to_string()))
    }
}

// ─── Plain HTTP Transitions (for JSON serialization layer) ─────

#[derive(Clone, Copy)]
struct SerializeNotes;

#[async_trait]
impl Transition<Vec<Note>, String> for SerializeNotes {
    type Error = anyhow::Error;
    type Resources = AppResources;

    async fn run(
        &self,
        notes: Vec<Note>,
        _res: &Self::Resources,
        _bus: &mut Bus,
    ) -> Outcome<String, Self::Error> {
        match serde_json::to_string(&notes) {
            Ok(json) => Outcome::Next(json),
            Err(e) => Outcome::Fault(e.into()),
        }
    }
}

#[derive(Clone, Copy)]
struct SerializeNote;

#[async_trait]
impl Transition<Note, String> for SerializeNote {
    type Error = anyhow::Error;
    type Resources = AppResources;

    async fn run(
        &self,
        note: Note,
        _res: &Self::Resources,
        _bus: &mut Bus,
    ) -> Outcome<String, Self::Error> {
        match serde_json::to_string(&note) {
            Ok(json) => Outcome::Next(json),
            Err(e) => Outcome::Fault(e.into()),
        }
    }
}

#[derive(Clone, Copy)]
struct HealthCheck;

#[async_trait]
impl Transition<(), String> for HealthCheck {
    type Error = anyhow::Error;
    type Resources = AppResources;

    async fn run(
        &self,
        _state: (),
        _res: &Self::Resources,
        _bus: &mut Bus,
    ) -> Outcome<String, Self::Error> {
        Outcome::Next(r#"{"status":"ok","version":"0.10.0"}"#.to_string())
    }
}

// ─── Main ──────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://ranvier:ranvierpass@localhost:5432/ranvier_db".to_string());

    tracing::info!("Connecting to DB: {}", database_url);

    // Retry loop handles container startup race condition
    let pool = {
        let mut result = None;
        for i in 1..=10 {
            match PostgresPool::new(&database_url).await {
                Ok(p) => {
                    result = Some(p);
                    break;
                }
                Err(e) => {
                    tracing::warn!("DB attempt {}: {}. Retrying in 2s…", i, e);
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                }
            }
        }
        result.expect("Failed to connect to database after 10 attempts")
    };

    // Bootstrap schema (idempotent)
    sqlx::query(
        "CREATE TABLE IF NOT EXISTS notes (
            id    SERIAL PRIMARY KEY,
            title VARCHAR NOT NULL,
            body  TEXT    NOT NULL
        )",
    )
    .execute(pool.inner())
    .await?;

    let resources = AppResources { pool };

    // Build circuits
    let health = Axon::<(), (), anyhow::Error, AppResources>::new("HealthCheck")
        .then(HealthCheck);

    let list = Axon::<(), (), anyhow::Error, AppResources>::new("ListNotes")
        .then(PgNode::new(ListNotes))
        .then(SerializeNotes);

    let create = Axon::<(), (), anyhow::Error, AppResources>::new("CreateNote")
        .then(ParseBody)
        .then(PgNode::new(CreateNote))
        .then(SerializeNote);

    println!("╔═══════════════════════════════════════════════╗");
    println!("║  Ranvier Fullstack Reference — Backend API    ║");
    println!("║  Listening on http://0.0.0.0:3000             ║");
    println!("╚═══════════════════════════════════════════════╝");

    Ranvier::http()
        .bind("0.0.0.0:3000")
        .get("/api/health", health)
        .get("/api/notes", list)
        .post("/api/notes", create)
        .run(resources)
        .await
        .map_err(|e| anyhow::anyhow!("{}", e))?;

    Ok(())
}
