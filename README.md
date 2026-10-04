# Ranvier Fullstack Order-Authorization Reference

This repository demonstrates the M420 canonical business workflow using the
exact Ranvier `0.51.0-m420.1` local candidate. The native adapter lets Ranvier
HTTP own routing and managed lifecycle. The hybrid adapter uses exact Axum
`0.8.9` and Tower `0.5.3` for routing, bounded middleware, and lifecycle. Both
delegate to one application-owned Axon for validation, policy, idempotency,
inventory/payment effects, compensation, and durable decision/audit behavior.

This remains maintainer-owned dogfood. It is not crates.io publication or an
independently owned adoption result.

## Why This Workflow

Notes CRUD has been removed because plain handlers are the better default for
simple CRUD. Order authorization has a concrete reason to use a typed decision
workflow:

```text
ValidateRequest
  -> ResolveIdempotency
  -> ScreenPolicy
  -> ReserveInventory
  -> AuthorizePayment
  -> RecordDecision
  -> CompleteAuthorization
```

Policy decisions occur before effects. A payment failure releases inventory.
A definite decision-write failure voids payment and then releases inventory.
An unknown commit outcome is reconciled before any compensation; blind
compensation is prohibited.

## Source and Runtime Boundaries

- The backend resolves exact registry dependencies from the committed local
  sparse candidate; it has no `path`, Git, or `[patch]` dependency.
- `node scripts/run-local-source.mjs ...` is an explicit maintainer-only source
  override and is excluded from adoption evidence.
- `backend/ranvier.toml` selects the typed production profile, JSON logging,
  disabled Inspector, and a 30-second managed drain deadline.
- PostgreSQL atomically stores the terminal decision and redacted audit event.
- `backend/src/http_contract.rs` is the single status/envelope mapping used by
  native and hybrid paths; adapter code cannot redefine domain policy.
- The hybrid path caps request bodies at 64 KiB, bounds concurrent requests at
  256, and enforces the same configured shutdown deadline as the native path.
- The runtime image is pinned, non-root, and contains the production config.
- Production Compose requires externally supplied PostgreSQL credentials and a
  complete `DATABASE_URL`; no production password default is committed.
- The static frontend and API share one Nginx origin; no permissive CORS policy
  is required.

## Verify

Prerequisites are Node 24 and Rust 1.95 (the crate MSRV remains Rust 1.93).

```bash
node scripts/candidate-cargo.mjs check --manifest-path backend/Cargo.toml --locked
node scripts/candidate-cargo.mjs test --manifest-path backend/Cargo.toml --locked
node scripts/candidate-cargo.mjs clippy --manifest-path backend/Cargo.toml --locked --all-targets -- -D warnings
node scripts/candidate-cargo.mjs run --manifest-path backend/Cargo.toml --locked --bin ranvier-fullstack-backend -- --schematic --output evidence/native-rq5-order-authorization-schematic.json
node scripts/candidate-cargo.mjs run --manifest-path backend/Cargo.toml --locked --bin hybrid -- --schematic --output evidence/hybrid-order-authorization-schematic.json
node scripts/compare-adapter-schematics.mjs
node scripts/compare-adapter-live-evidence.mjs
```

The twelve native HTTP tests exercise S1-S8 through Ranvier's in-process HTTP/1
boundary, plus invalid input, production startup policy, Schematic structure,
and structured graceful shutdown. Three hybrid tests compare every S1-S8
response and complete redacted evidence snapshot against native behavior,
verify a stable malformed-JSON fault, and exercise bounded Axum shutdown.

## Run

```bash
pwsh scripts/deploy-local.ps1
# or: bash scripts/deploy-local.sh
```

Open `http://localhost:8080`, or call the public behavior directly:

```bash
curl -sS http://localhost:8080/api/order-authorizations \
  -H 'content-type: application/json' \
  -d '{
    "order_id":"order-demo-001",
    "idempotency_key":"idem-demo-001",
    "customer_id":"customer-demo",
    "items":[{"item_id":"sku-001","quantity":2}],
    "amount_minor":12500,
    "currency":"USD",
    "payment_reference":"payment-token-demo",
    "fixture":"normal"
  }'
```

Run the Axum/Tower hybrid against the same production policy and PostgreSQL
contract (use a different port if native is already running):

```bash
export DATABASE_URL='postgres://ranvier:secret@127.0.0.1:5432/ranvier'
export RANVIER_SERVER_PORT=3001
node scripts/candidate-cargo.mjs run --manifest-path backend/Cargo.toml --locked --bin hybrid
```

The backend container defaults to the native target. Build the same pinned,
non-root runtime with `--target hybrid` to publish the hybrid binary.

Changing only the fixture selects the deterministic scenarios:

| Scenario | Fixture | Expected public behavior |
|---|---|---|
| S1 | `normal` | Approved; one reservation, payment, decision, and audit |
| S2 | `manual_review` | ManualReview; no external effect |
| S3 | `policy_rejected` | Rejected; no external effect |
| S4 | `out_of_stock` | structured 422 fault; no payment |
| S5 | `payment_declined` | structured 422 fault; inventory released once |
| S6 | `decision_write_failure` | structured 503 fault; payment voided, then inventory released |
| S7 | repeat an identical request | original result; no repeated effect |
| S8 | `ack_lost_after_commit` | committed result recovered before compensation |

## Public Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | candidate and selected-adapter health |
| `POST` | `/api/order-authorizations` | typed terminal result or structured fault |
| `GET` | `/api/order-authorizations/evidence` | redacted decisions, audit, effects, and domain trace |

The evidence response never contains raw payment data, credentials, email, or
access tokens. The request's `payment_reference` is explicitly non-secret and
is used only to compute the request digest; it is not persisted in evidence.

## M429-RQ2 S1 Load Runner

`scripts/measure-order-authorizations.mjs` captures bounded S1 request latency,
HTTP outcomes, and Linux process memory using Node.js 24 with no added packages.
It sends the fixed `normal` fixture and generates a unique `order_id` and
`idempotency_key` for each warmup and measurement request:

```bash
node scripts/measure-order-authorizations.mjs \
  --base-url http://127.0.0.1:8080 \
  --adapter native \
  --run-id pilot-20261003-01 \
  --server-pid 1234 \
  --concurrency 8 \
  --warmup-seconds 10 \
  --duration-seconds 30 \
  --request-timeout-ms 5000 \
  --output-dir evidence/benchmark-comparison
```

The runner accepts concurrency 1–256, warmup 0–3600 seconds, measurement
duration 1–3600 seconds, and request timeout 1–120000 ms. All required values
are checked before it creates a run directory or sends traffic. Use a fresh,
unique `--run-id`; an existing output directory is never overwritten. The
command's `1234` is an example only; replace it with the measured server's
verified Linux PID before running. The
runner requires Linux `/proc` and samples `VmRSS` and `VmHWM` at one-second
intervals. It also checks `/proc/<pid>/stat` so a reused PID cannot silently
switch the sampled process. Missing or invalid RSS samples, server exit, PID
identity change, HTTP errors, timeouts, and malformed S1 responses invalidate
the run.

Each run writes `summary.json`, request `samples.jsonl.gz`, and
`rss-samples.jsonl.gz` below `<output-dir>/<run-id>/`; the summary schema is
version `1.1.0`. Request JSONL rows retain
warmup/measurement phase, request ID, monotonic latency, HTTP status, S1
outcome, and a bounded error kind; response bodies and request payloads are
not copied. RSS JSONL rows retain elapsed time, `VmRSS`, `VmHWM`, the observed
process start time when available, and a final-sample marker. Warmup request
rows remain available for diagnosis but are excluded from measurement counts,
latency percentiles, and throughput. The reported sampled `VmRSS` peak is a
one-second observation, not a guarantee that no higher transient value
occurred. Linux `VmHWM` is process-lifetime high-water memory, so the report
includes its value at the first sample, final value, and increase during this
run. Backpressure on either compressed sample stream marks the capture
invalid; the summary records request and RSS writer counters separately.

A runner `PASS` means its captured S1 requests succeeded and RSS collection
completed. `comparison_eligibility` intentionally remains `NOT_ASSESSED`: this
command does not run the S1–S8 correctness preflight, prove the database is a
fresh isolated disposable instance, approve resource/time budget, or establish
parity across adapter environments. Run it only after those M429-RQ2 gates are
reviewed; a successful runner result alone is not a baseline, comparison, or
product performance claim. The offline mock-server tests are run with:

```bash
node --test scripts/measure-order-authorizations.test.mjs
```

## Layout

```text
backend/src/domain.rs  shared application workflow and deterministic effect ledger
backend/src/http_contract.rs  shared terminal envelope and status mapping
backend/src/store.rs   in-memory test and atomic PostgreSQL decision stores
backend/src/native.rs  native Ranvier HTTP and managed lifecycle adapter
backend/src/hybrid.rs  Axum/Tower routes, middleware, and bounded lifecycle
backend/tests/         native scenarios, operations, and exact adapter parity
frontend/              static scenario runner plus isolated Nginx build context
docker/                pinned backend and compose runtime topology
candidate-registry/    exact M420 prerelease candidate artifacts
```
