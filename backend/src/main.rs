use ranvier_fullstack_backend::{authorization_workflow, run_native_from_env};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let workflow = authorization_workflow();
    if workflow.maybe_export_and_exit()? {
        return Ok(());
    }

    run_native_from_env().await
}
