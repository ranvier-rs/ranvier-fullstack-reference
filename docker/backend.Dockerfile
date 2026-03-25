# ── Builder stage ────────────────────────────────────────────
# Uses the official musl builder image — compiles a fully-static Linux binary
FROM clux/muslrust:stable AS builder

WORKDIR /build
# Copy workspace crates that backend depends on (path deps)
COPY ranvier/core          ./ranvier/core
COPY ranvier/runtime       ./ranvier/runtime
COPY ranvier/http          ./ranvier/http
COPY ranvier/macros        ./ranvier/macros
COPY ranvier/guard         ./ranvier/guard
COPY ranvier/extensions/audit     ./ranvier/extensions/audit
COPY ranvier/extensions/inspector ./ranvier/extensions/inspector
COPY ranvier/std           ./ranvier/std

# Copy the backend application
COPY ranvier-fullstack-reference/backend ./backend

WORKDIR /build/backend

# Build a fully static musl binary
RUN cargo build --release --target x86_64-unknown-linux-musl

# ── Runtime stage ────────────────────────────────────────────
# Distroless/scratch: no shell, no OS overhead — just the binary
FROM scratch

COPY --from=builder \
    /build/backend/target/x86_64-unknown-linux-musl/release/ranvier-fullstack-backend \
    /server

EXPOSE 3000
ENTRYPOINT ["/server"]
