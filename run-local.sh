#!/usr/bin/env bash
# Starts the backend for local demo use. Env is exported into the process,
# not just handed to @fastify/env — the auth plugin reads process.env directly.
set -euo pipefail
cd "$(dirname "$0")"
set -a
# shellcheck disable=SC1091
source .env
set +a
exec pnpm dev
