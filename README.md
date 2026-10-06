# Whispera server

> **License:** GNU AGPL-3.0-only (see [LICENSE](LICENSE)). If you run a modified
> version as a network service, you must offer its source to its users.
> Commercial licenses are available — see [COMMERCIAL.md](COMMERCIAL.md).
> Contributions require a CLA — see [CONTRIBUTING.md](CONTRIBUTING.md).

A small, self-hostable Rust server for Whispera Link: it keeps each account's
device registry, relays **end-to-end encrypted** messages between an account's
devices, and sends **content-free** push notifications to iPhones. One binary,
SQLite by default, Postgres optional. We host one; anyone can run their own.

What the server can see: device ids, names, platforms, public keys, APNs tokens
and opaque ciphertext sizes/timestamps. It never sees message contents and holds
no approve keys, so it cannot forge approvals.

The previous TypeScript backend is archived under [`legacy/`](legacy/) for reference.

## Workspace

| Crate | Purpose |
|---|---|
| `crates/proto` | WL1 request signing, P-256 key encodings, error envelope, wire types (no I/O) |
| `crates/auth` | Account auth: generic OIDC (discovery + JWKS) or static hashed tokens |
| `crates/store` | sqlx persistence: `accounts`, `devices`, `mailbox` (SQLite / Postgres) |
| `crates/relay` | E2E mailbox (TTL, size and per-device quota caps) and WL1 device auth |
| `crates/apns` | APNs token auth (ES256), HTTP/2 client, payloads only from a typed push kind |
| `crates/stt` | Transcription server registry + LocalAgreement-2 synthesized deltas (ported from TS) |
| `crates/server` | axum binary `whispera-server` |
| `crates/apns-mock` | **dev/test only**: `whispera-apns-mock`, a local APNs endpoint that records pushes as JSONL |
| `crates/dev-idp` | **dev/test only**: `whispera-dev-idp`, a loopback OIDC provider for local sign-in |

## Self-hosting

### Quick start (Docker, SQLite, static token)

```sh
docker compose build
docker compose run --rm whispera gen-token me
# token (give to the client, shown once): wst_…
# WHISPERA_STATIC_TOKENS entry: me:3f1c…
echo 'WHISPERA_STATIC_TOKENS=me:3f1c…' > .env
docker compose up -d
curl http://localhost:8080/v1/health
```

Data lives in the `whispera-data` volume (`/data/whispera.db`). Put the server
behind TLS (Caddy, nginx, Cloudflare Tunnel, …) before exposing it.

Without Docker: `cargo build --release -p whispera-server` (add
`--features postgres` for Postgres), then run `target/release/whispera-server`.

### Default-closed

The server refuses to start unless account auth is configured, and every route
except `GET /v1/health` requires either an account bearer token or a WL1 device
signature. There is no "disable auth" switch.

### Configuration

Settings come from an optional TOML file (`WHISPERA_CONFIG=/path/whispera.toml`,
see [`whispera.example.toml`](whispera.example.toml)), then environment
variables, which win. Empty variables are ignored.

| Variable | Meaning | Default |
|---|---|---|
| `WHISPERA_CONFIG` | Path to the TOML file | none |
| `WHISPERA_LISTEN` | Listen address | `0.0.0.0:8080` |
| `WHISPERA_DATABASE_URL` | `sqlite:///path/db.sqlite` or `postgres://…` | `sqlite://whispera.db` |
| `WHISPERA_TRUST_PROXY_HEADERS` | Use `CF-Connecting-IP` / `X-Forwarded-For` for rate limiting | `false` |
| `WHISPERA_RATE_LIMIT_PER_SECOND` / `_BURST` | Per-IP token bucket (0 disables) | `20` / `60` |
| `WHISPERA_STATIC_TOKENS` | Static-token mode: `account:sha256hex,…` | — |
| `WHISPERA_OIDC_ISSUER` | OIDC mode: issuer URL | — |
| `WHISPERA_OIDC_AUDIENCES` | Accepted `aud` values, comma-separated | — |
| `WHISPERA_OIDC_AUTHORIZED_PARTIES` | Accepted `azp` values, comma-separated | — |
| `WHISPERA_OIDC_JWKS_URI` | Skip discovery and use this JWKS URL | discovered |
| `WHISPERA_OIDC_ALLOWED_ALGS` | e.g. `ES384` | `RS256,ES256` |
| `APNS_AUTH_KEY_P8_FILE` or `APNS_AUTH_KEY_P8` | APNs `.p8` key (path, or PEM contents) | push off |
| `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` | APNs key id, team id, app bundle id | push off |
| `APNS_SANDBOX_URL` / `APNS_PRODUCTION_URL` | Send that environment's pushes to this URL instead of Apple (mock switch, see below) | Apple |
| `RUST_LOG` | Log filter | `info` |

Relay caps (TOML `[relay]`): 64 KiB per ciphertext, TTL 1 day by default and
7 days max, 1000 messages / 16 MiB queued per device, 100 messages per fetch,
30 s max long-poll. Expired messages are purged every minute.

### Account auth: static tokens

For a personal server with no identity provider. `whispera-server gen-token NAME`
prints a random token and the `NAME:sha256` line for `WHISPERA_STATIC_TOKENS`.
Only the hash is stored in config; give the token to your apps. Several
`name:hash` pairs, comma-separated, give several accounts.

### Account auth: OIDC

Any OpenID Connect provider with a JWKS works; the provider is pure config. The
server fetches `<issuer>/.well-known/openid-configuration`, then the JWKS (cached
10 min, refetched on an unknown `kid`). It checks `alg` (RS256/ES256 by default,
never `none`/HS*), signature, exact `iss`, `exp`/`nbf`/`iat`, and audience. You
must set `audiences` (matched against `aud`) or `authorized_parties` (matched
against `azp`) — a token for some other app of the same issuer is never accepted.
An account is identified by `(iss, sub)`.

| Provider | `WHISPERA_OIDC_ISSUER` | Audience binding |
|---|---|---|
| **Clerk** | `https://<slug>.clerk.accounts.dev` (dev) or `https://clerk.<your-domain>` (prod) | Browser session tokens carry `azp`: set `WHISPERA_OIDC_AUTHORIZED_PARTIES` to your app origins. For native apps, create a JWT template with `"aud": "whispera"` and set `WHISPERA_OIDC_AUDIENCES=whispera`. |
| **Zitadel** | `https://<instance>.zitadel.cloud` (or your domain) | Set the app's token type to JWT; `WHISPERA_OIDC_AUDIENCES=<project id>`. |
| **Authentik** | `https://<host>/application/o/<app-slug>/` | `WHISPERA_OIDC_AUDIENCES=<client id>`. |
| **Keycloak** | `https://<host>/realms/<realm>` | Add an "Audience" mapper for your client; `WHISPERA_OIDC_AUDIENCES=<client id>`. |
| **Logto** | `https://<tenant>.logto.app/oidc` | Create an API resource and request tokens for it; `WHISPERA_OIDC_AUDIENCES=<resource indicator>`, `WHISPERA_OIDC_ALLOWED_ALGS=ES384`. |

Discovery and JWKS URLs must be `https` (plain `http` is allowed only for loopback).

### Push (APNs)

Push is optional; without `APNS_*` (or an `[apns]` TOML section) it is disabled
and `/v1/notify` answers `{"push":"unconfigured"}`. With it, the server signs an
ES256 provider token (cached ~50 min) and talks HTTP/2 to Apple. Payloads are
built only from a typed push kind (legacy alert, approval, approval.resolved):
fixed strings plus a validated `request_id` and, for named approvals, an opaque
end-to-end sealed blob the server cannot read. No free text from a request ever
reaches a push. Tokens Apple reports as unregistered (`410`, `BadDeviceToken`)
are deleted. The key is never logged.

```sh
APNS_AUTH_KEY_P8_FILE=/run/secrets/apns.p8   # mount AuthKey_XXXX.p8 read-only
APNS_KEY_ID=ABC123DEFG
APNS_TEAM_ID=TEAM123456
APNS_TOPIC=com.example.whispera              # the iOS app bundle id
```

#### Mock switch: `whispera-apns-mock`

To test push end to end without Apple, point the APNs client at the bundled
mock. `[apns] sandbox_url` / `production_url` (or `APNS_SANDBOX_URL` /
`APNS_PRODUCTION_URL`) replace Apple's endpoint for that environment; omitted
means Apple. The server logs at startup which endpoint each environment uses
(`Apple` or `custom URL …`). A key is still required (any P-256 PKCS#8 key works
against the mock), so real delivery needs a real APNs key on a hosted backend
with the URLs left unset.

```sh
# throwaway key (never commit it)
openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out key.p8
openssl ec -in key.p8 -pubout -out key.pub.pem

cargo run -p whispera-apns-mock -- --listen 127.0.0.1:18082 --log pushes.jsonl \
    --public-key key.pub.pem \
    [--exec 'sh -c "xcrun simctl push booted com.example.whispera -" _'] \
    [--unregistered <token-suffix>]
```

```toml
[apns]
key_path = "key.p8"
key_id = "ABC123DEFG"
team_id = "TEAM123456"
topic = "com.example.whispera"
sandbox_url = "http://127.0.0.1:18082"      # omit for Apple
# production_url = "http://127.0.0.1:18082/production"
```

The mock answers `200` (`410 Unregistered` for tokens ending in an
`--unregistered` suffix, `403 InvalidProviderToken` when `--public-key` is set and
the JWT does not verify) and appends one JSON line per request:
`{"ts","path_token_suffix","token","env","headers":{apns-*},"jwt_ok","payload"}`.
`env` comes from a leading `/sandbox` or `/production` path segment, else
`--env` (default `sandbox`). `--exec '<cmd>'` runs `<cmd> <token>` with the
payload JSON on stdin (the `sh -c "…" _` wrapper above drops the token argument
for commands that don't take it). `crates/server/tests/apns_mock_e2e.rs` runs the real
server binary against it.

### Postgres

Build with `--features postgres` (the Docker image includes it) and set
`WHISPERA_DATABASE_URL=postgres://user:pass@host/db`. Migrations run at startup.

### Reverse proxies

WL1 signatures cover the method and the exact path + query the client sent.
Proxy the server at the root of its host (no path prefix rewriting). If you
enable `WHISPERA_TRUST_PROXY_HEADERS`, make sure the proxy overwrites
`X-Forwarded-For` / `CF-Connecting-IP`.

## API reference

All bodies are JSON. Errors use one envelope:

```json
{"error": {"code": "auth_revoked", "message": "device revoked", "type": "auth_error"}}
```

`auth_clock_skew` errors also carry `server_time`. Codes and statuses are in
`crates/proto/src/error.rs`.

### Authentication

- **Account** routes take `Authorization: Bearer <token>` (static token or OIDC JWT).
  Errors: `401 auth_account_missing`, `401 auth_account_invalid`, `503 auth_unavailable`.
- **Device** routes take a WL1 signature with the device's registered link key:

  ```
  X-WL-Device:    dev_…
  X-WL-Timestamp: <unix seconds>
  X-WL-Nonce:     <22 chars base64url, 16 random bytes>
  X-WL-Signature: base64(DER ECDSA-P256-SHA256(string_to_sign))

  string_to_sign = "WL1\n" + METHOD + "\n" + path_and_query + "\n"
                 + hex(sha256(body)) + "\n" + timestamp + "\n" + nonce + "\n" + device_id
  ```

  Timestamps must be within ±60 s; each nonce is accepted once. Errors:
  `401 auth_missing | auth_unknown_device | auth_revoked | auth_clock_skew | auth_bad_signature | auth_replay`.
  A revoked device gets `401 auth_revoked` on every call.

### Endpoints

| Method & path | Auth | Request | Response |
|---|---|---|---|
| `GET /v1/health` | — | — | `200 {"ok","service","version","protocol":1,"server_time","apns":"configured"\|"unconfigured"}` |
| `POST /v1/devices` | account | `{"name","platform":"ios"\|"macos"\|"linux"\|"other","link_pubkey","approve_pubkey"?,"kem_pubkey"?,"apns"?:{"token","env":"sandbox"\|"production"}}` | `201` device |
| `GET /v1/devices` | account | — | `200 {"devices":[device…]}` (revoked ones included, with `revoked_at`) |
| `DELETE /v1/devices/{id}` | account | — | `204`; `404` if not an active device of this account. Drops its mail and push token, ends its streams. |
| `GET /v1/device/peers` | device | — | `200 {"devices":[…]}` — the caller's account devices |
| `PUT /v1/device/apns` | device | `{"apns":{"token":"<64-200 hex>","env":"sandbox"\|"production"}}` or `{"apns":null}` to clear | `200` the caller's device; `400` bad token/env or missing `apns` key |
| `POST /v1/relay/send` | device | `{"to":"dev_…","ciphertext":"<base64>","ttl_s"?}` | `201 {"seq","expires_at"}`; `404` unknown/revoked/other-account recipient, `413` too large, `429 mailbox_full` |
| `GET /v1/relay/messages?after=N&limit=L&wait=S` | device | — | `200 {"messages":[{"seq","from","ciphertext","created_at","expires_at"}]}`; with `wait`, long-polls up to S s (max 30) |
| `POST /v1/relay/ack` | device | `{"up_to_seq":N}` | `200 {"deleted":n}` |
| `GET /v1/relay/stream?after=N` | device | — | `text/event-stream`: `event: message`, `id: <seq>`, `data: <message JSON>`; resumes from `Last-Event-ID`; ends when the device is revoked |
| `POST /v1/notify` | device | `{"device_id":"dev_…","kind"?:"approval"\|"approval.resolved","request_id"?:"apr_[a-z0-9]{8,64}","sealed"?:"<std base64 ≤ 2048, kind approval only>"}`; unknown fields rejected | `200 {"push":"sent"\|"unconfigured"\|"no_token"\|"failed"}`; `400 bad_request` on a bad combination or format; `404` if not an active device of the same account |

`/v1/notify` APNs payloads (`kind` absent = legacy):

| kind | payload | headers |
|---|---|---|
| — | `{"aps":{"alert":{"title":"Whispera","body":"You have a new request"},"sound":"default"}}` | `alert`, priority 10, expiration +3600 s |
| `approval` | `{"aps":{"alert":{"title":"Whispera","body":"Approval requested"},"sound":"default","category":"WL_APPROVAL","thread-id":"wl-approvals"},"wl":{"kind":"approval","request_id":"apr_…"}}`; with `sealed` also `"aps":{"mutable-content":1}` and `"wl":{"sealed":"…"}` | `alert`, priority 10, `apns-collapse-id: <request_id>`, expiration +300 s |
| `approval.resolved` | `{"aps":{"content-available":1},"wl":{"kind":"approval.resolved","request_id":"apr_…"}}` | `background`, priority 5, expiration +300 s |

A device object:

```json
{"device_id":"dev_…","name":"iPhone","platform":"ios",
 "link_pubkey":"BNRB…","approve_pubkey":"BFYd…","kem_pubkey":"…",
 "link_fp":"6dfe…","approve_fp":"671c…",
 "apns_token_suffix":"5c6d7e8f90","apns_env":"production",
 "created_at":1791158400,"revoked_at":null}
```

Public keys are P-256 X9.63 uncompressed points in standard base64;
fingerprints are hex SHA-256 of the SPKI DER. `kem_pubkey` is opaque to the
server (clients choose the sealing scheme). Only the last 8 characters of an
APNs token are ever returned.

Relay delivery: `seq` only grows. Read with `after=<last seq you processed>`,
then ack `up_to_seq` to delete. Messages a device never acks expire after
their TTL.

## Development

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
# store tests against Postgres too:
WHISPERA_TEST_POSTGRES_URL=postgres://postgres:test@localhost:5432/postgres \
  cargo test -p whispera-store --features postgres
```

### Local development with accounts

`whispera-dev-idp` is a tiny OpenID Connect provider for development and tests
**only**: no passwords (anyone who can reach it signs in as any configured user),
and it refuses to bind anything but loopback. It serves discovery, an ES256
JWKS, `/authorize` (authorization code + PKCE S256 + `state` required; a page with
one button per user, or `login_hint=<user>` to approve at once) and `/token`
(`authorization_code`, `refresh_token`). Tokens: `iss` = its base URL, `aud` =
client id (`whispera`), `sub` = the user name, 1 h lifetime. Redirect URIs are
allow-listed (default `whispera://auth/callback`, `whispera-mac://auth/callback`).

```sh
cargo build -p whispera-server -p whispera-dev-idp

# 1. provider on http://127.0.0.1:18081, users alice + bob
target/debug/whispera-dev-idp serve            # --users a,b --redirect-uris … --help

# 2. server in OIDC mode against it
WHISPERA_OIDC_ISSUER=http://127.0.0.1:18081 WHISPERA_OIDC_AUDIENCES=whispera \
WHISPERA_LISTEN=127.0.0.1:8080 WHISPERA_DATABASE_URL=sqlite://dev.db \
  target/debug/whispera-server

# 3. a token for curl or a soft client (same key file as `serve`)
TOKEN=$(target/debug/whispera-dev-idp mint alice)
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/v1/devices
```

The same server settings as a `WHISPERA_CONFIG` file:

```toml
listen = "127.0.0.1:8080"
database_url = "sqlite://dev.db"

[auth]
mode = "oidc"
issuer = "http://127.0.0.1:18081"
audiences = ["whispera"]
```

Apps point their custom-issuer setting at `http://127.0.0.1:18081` with client id
`whispera`. `alice` and `bob` are separate accounts. The signing key lives in
`$TMPDIR/whispera-dev-idp/es256.pem` (`--key-file` to move it,
`--ephemeral-key` for a throwaway one); `mint` must use the same file as the
running `serve`.

Without an identity provider, use static-token mode instead:

```sh
target/debug/whispera-server gen-token alice   # prints the token + `alice:<sha256>`
WHISPERA_STATIC_TOKENS=alice:<sha256>,bob:<sha256> WHISPERA_LISTEN=127.0.0.1:8080 \
  WHISPERA_DATABASE_URL=sqlite://dev.db target/debug/whispera-server
```

The integration tests (`crates/server/tests/integration.rs`) run the real
router on a temporary SQLite file, including OIDC with a locally generated JWKS
and OIDC mode against `whispera-dev-idp` over loopback HTTP.
