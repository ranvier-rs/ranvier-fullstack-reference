use async_trait::async_trait;
use ranvier_core::prelude::*;
use ranvier_runtime::Axon;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema, PartialEq, Eq)]
pub struct PingRequest {
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PingResponse {
    pub echoed: String,
    pub source: String,
}

#[derive(Clone, Copy)]
pub struct Ping;

#[async_trait]
impl Transition<PingRequest, PingResponse> for Ping {
    type Error = String;
    type Resources = ();

    fn label(&self) -> String {
        "PublishedCandidatePing".to_string()
    }

    async fn run(
        &self,
        input: PingRequest,
        _resources: &Self::Resources,
        _bus: &mut Bus,
    ) -> Outcome<PingResponse, Self::Error> {
        if input.value.trim().is_empty() {
            return Outcome::fault("value must not be empty".to_string());
        }
        Outcome::next(PingResponse {
            echoed: input.value,
            source: "registry-prerelease".to_string(),
        })
    }
}

pub fn ping_axon() -> Axon<PingRequest, PingResponse, String, ()> {
    Axon::typed::<PingRequest, String>("m420-consumer-smoke").then(Ping)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn executes_candidate_dependency() {
        let mut bus = Bus::new();
        let outcome = ping_axon()
            .execute(
                PingRequest {
                    value: "candidate".to_string(),
                },
                &(),
                &mut bus,
            )
            .await;
        match outcome {
            Outcome::Next(response) => assert_eq!(
                response,
                PingResponse {
                    echoed: "candidate".to_string(),
                    source: "registry-prerelease".to_string(),
                },
            ),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }
}
