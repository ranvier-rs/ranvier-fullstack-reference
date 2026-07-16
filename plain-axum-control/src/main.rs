use std::env;
use std::sync::Arc;
use std::time::Duration;

use plain_axum_order_authorization::{OrderService, PgDecisionStore, serve_with_shutdown};

async fn connect_postgres(database_url: &str) -> Result<sqlx::PgPool, std::io::Error> {
    for attempt in 1..=10 {
        match sqlx::postgres::PgPoolOptions::new()
            .max_connections(16)
            .connect(database_url)
            .await
        {
            Ok(pool) => return Ok(pool),
            Err(_) if attempt < 10 => {
                tracing::warn!(attempt, "PostgreSQL connection unavailable; retrying");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(_) => break,
        }
    }
    Err(std::io::Error::other(
        "PostgreSQL connection failed after bounded retries",
    ))
}

#[cfg(unix)]
async fn operating_system_shutdown() {
    use tokio::signal::unix::{SignalKind, signal};

    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {},
                _ = terminate.recv() => {},
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(not(unix))]
async fn operating_system_shutdown() {
    let _ = tokio::signal::ctrl_c().await;
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let database_url = env::var("DATABASE_URL")
        .map_err(|_| "DATABASE_URL is required for the production control")?;
    let bind = env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_string());
    let drain_secs = env::var("SHUTDOWN_TIMEOUT_SECS")
        .unwrap_or_else(|_| "30".to_string())
        .parse::<u64>()?;
    if !(1..=300).contains(&drain_secs) {
        return Err("SHUTDOWN_TIMEOUT_SECS must be between 1 and 300".into());
    }
    let pool = connect_postgres(&database_url).await?;
    let store = PgDecisionStore::initialize(pool).await?;
    let listener = tokio::net::TcpListener::bind(&bind).await?;

    tracing::info!(adapter = "plain-axum-control", bind = %bind, "starting control service");
    serve_with_shutdown(
        listener,
        OrderService::new(Arc::new(store)),
        operating_system_shutdown(),
        Duration::from_secs(drain_secs),
    )
    .await?;
    Ok(())
}
