use ranvier_http::prelude::*;
use ranvier_m420_consumer_smoke::ping_axon;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let axon = ping_axon();
    if axon.maybe_export_and_exit()? {
        return Ok(());
    }
    let bind = std::env::var("M420_SMOKE_BIND").unwrap_or_else(|_| "127.0.0.1:43118".to_string());
    Ranvier::http::<()>()
        .bind(bind)
        .post_typed_json_out("/ping", axon)
        .run(())
        .await
}
