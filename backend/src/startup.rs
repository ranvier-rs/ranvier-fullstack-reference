use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use ranvier_core::prelude::{RanvierConfig, ResolvedRuntimeConfig, RuntimeProfile};

use crate::domain::OrderResources;
use crate::store::PgDecisionStore;

pub struct ProductionContext {
    pub config: RanvierConfig,
    pub resources: OrderResources,
}

fn production_config_path() -> PathBuf {
    if let Some(path) = std::env::var_os("RANVIER_CONFIG") {
        return PathBuf::from(path);
    }
    let repository_path = Path::new("backend/ranvier.toml");
    if repository_path.is_file() {
        repository_path.to_path_buf()
    } else {
        PathBuf::from("ranvier.toml")
    }
}

async fn connect_postgres(database_url: &str) -> Result<sqlx::PgPool, std::io::Error> {
    for attempt in 1..=10 {
        match sqlx::PgPool::connect(database_url).await {
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

pub async fn load_production_context()
-> Result<ProductionContext, Box<dyn std::error::Error + Send + Sync>> {
    let resolved =
        ResolvedRuntimeConfig::from_file_for(production_config_path(), RuntimeProfile::Production)
            .map_err(|_| std::io::Error::other("production configuration resolution failed"))?;
    resolved
        .validate_startup(&[])
        .map_err(|_| std::io::Error::other("production startup policy validation failed"))?;
    let config = resolved.config().clone();
    config.init_logging();

    let database_url = std::env::var("DATABASE_URL").map_err(|_| {
        std::io::Error::other("DATABASE_URL must be configured for the production profile")
    })?;
    let pool = connect_postgres(&database_url).await?;
    let store = PgDecisionStore::initialize(pool)
        .await
        .map_err(|_| std::io::Error::other("order decision schema initialization failed"))?;

    Ok(ProductionContext {
        config,
        resources: OrderResources::new(Arc::new(store)),
    })
}
