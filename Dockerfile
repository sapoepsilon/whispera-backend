# syntax=docker/dockerfile:1
# Whispera server — self-hostable single binary (SQLite by default, Postgres optional).
# SPDX-License-Identifier: AGPL-3.0-only

FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p whispera-server --features postgres \
    && cp target/release/whispera-server /usr/local/bin/whispera-server

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin whispera \
    && mkdir -p /data && chown whispera /data
COPY --from=build /usr/local/bin/whispera-server /usr/local/bin/whispera-server
USER whispera
VOLUME ["/data"]
ENV WHISPERA_LISTEN=0.0.0.0:8080 \
    WHISPERA_DATABASE_URL=sqlite:///data/whispera.db \
    RUST_LOG=info
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/whispera-server"]
