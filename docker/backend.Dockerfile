# ── Builder stage ────────────────────────────────────────────
FROM rust:1.85-slim as builder

WORKDIR /app
# Copy the full workspace context so path deps resolve
COPY . .
WORKDIR /app/backend

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
RUN cargo build --release

# ── Runtime stage ────────────────────────────────────────────
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/backend/target/release/ranvier-fullstack-backend /usr/local/bin/server

EXPOSE 3000
CMD ["server"]
