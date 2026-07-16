# Plain Axum Order-Authorization Control

This crate is the frozen M420-RQ6 control. It implements the same S1-S8 public
contract, PostgreSQL decision/audit transaction, idempotency reconciliation,
effect ledger, compensation order, body/concurrency limits, and bounded
shutdown as the native and hybrid references. It has no Ranvier, path, Git, or
patch dependency.

The control is intentionally production-shaped, but it is maintainer dogfood.
It is not independent adoption evidence and it cannot close M420-RQ7.

## Verify

```bash
cargo fmt --all -- --check
cargo check --locked --all-targets
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
cargo audit --file Cargo.lock
```

The declared MSRV is Rust 1.93.0. The retained RQ6 gate also runs locked check
and all tests in the exact `rust:1.93.0-bookworm` Linux image.

## Run

After Podman and PostgreSQL credentials are available, the four setup commands
used by the comparison are:

```bash
podman network create rq6
podman build -f Containerfile -t localhost/ranvier-m420-rq6-plain-axum:test .
podman run -d --name rq6-db --network rq6 -e POSTGRES_USER=rq6 -e POSTGRES_PASSWORD=change-me -e POSTGRES_DB=rq6 postgres:16-alpine
podman run --rm --network rq6 -p 3000:3000 -e DATABASE_URL=postgres://rq6:change-me@rq6-db:5432/rq6 localhost/ranvier-m420-rq6-plain-axum:test
```

Use externally managed secrets in a real deployment. The example credential is
local-only and is not a production default.

## Comparison boundary

The procedural service exposes named step/state traces and typed faults, but it
does not generate a domain graph. The Ranvier paths add an 8-node/7-edge
Schematic and let native HTTP and Axum/Tower share one domain implementation.
The control keeps its separate procedural domain so the comparison does not
hide Ranvier dependencies or reuse Ranvier-owned workflow code.

Raw measurements and normalized public-behavior parity are under `../evidence/`.
