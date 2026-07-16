# syntax=docker/dockerfile:1

FROM docker.io/library/rust:1.95.0-bookworm@sha256:4c2fd73ef19c5ef9d54bee03b06b2839a392604fbfcd578ed948b71b37c1d7fb AS builder

WORKDIR /build
COPY .cargo ./.cargo
COPY candidate-registry ./candidate-registry
COPY backend ./backend

# Cargo's sparse protocol requires HTTP. Both servers are build-local and read
# only the committed candidate artifacts; no sibling Ranvier source is copied.
RUN set -eu; \
    python3 -m http.server 43117 --bind 127.0.0.1 --directory /build/candidate-registry/index >/tmp/index.log 2>&1 & index_pid=$!; \
    python3 -m http.server 43119 --bind 127.0.0.1 --directory /build/candidate-registry/crates >/tmp/crates.log 2>&1 & crates_pid=$!; \
    trap 'kill -TERM "$index_pid" "$crates_pid" 2>/dev/null || true' EXIT; \
    for attempt in $(seq 1 30); do curl --fail --silent http://127.0.0.1:43117/config.json >/dev/null && break; sleep 0.1; done; \
    curl --fail --silent http://127.0.0.1:43117/config.json >/dev/null; \
    cargo build --manifest-path backend/Cargo.toml --locked --release; \
    kill -TERM "$index_pid" "$crates_pid"; \
    wait "$index_pid" "$crates_pid" || true; \
    trap - EXIT

FROM docker.io/library/debian:bookworm-slim@sha256:63a496b5d3b99214b39f5ed70eb71a61e590a77979c79cbee4faf991f8c0783e

WORKDIR /app
COPY --from=builder /build/backend/target/release/ranvier-fullstack-backend /app/server
COPY backend/ranvier.toml /app/ranvier.toml

USER 65532:65532
EXPOSE 3000
ENV RANVIER_CONFIG=/app/ranvier.toml
ENTRYPOINT ["/app/server"]
