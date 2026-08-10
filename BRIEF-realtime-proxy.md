# Brief: incorporate speaches into whispera-backend as a streaming transcription source

You are working in an **isolated git worktree**. Everything you need is here. Do not touch any path outside this worktree.

- Worktree: `/Users/uzi/Developer/whispera-backend-worktrees/realtime-proxy`
- Branch: `feat/realtime-transcription-proxy`
- Based on: `feat/pluggable-transcription-providers` (commit `4c10f05`), which is now backed up on origin
- **Never** check out, rebase onto, or push to `main` or `feat/pluggable-transcription-providers`.

## Goal

whispera-backend already transcribes **batch** audio through a pluggable provider. Add a **streaming** path so the Mac client can open a WebSocket and receive words while the user speaks.

The owner's framing, verbatim: *"just incorporate speaches into the back end, create a route that says 'available servers' so we can use it in the front end, then get the WebSocket connected on the front end. We can connect to that route and add more things. We can unify those things under some kind of interface."*

speaches is **not** replacing the backend. It is one transcription source behind the backend's own interface.

## Verified facts — do not re-derive these

Checked live on 2026-08-09 from this Mac:

- **speaches is reachable**: `http://192.168.50.140:8000` (LXC CT137 on the LAN).
- `GET /v1/models` → `200`, one model loaded: `Systran/faster-distil-whisper-large-v3`.
- `GET /v1/realtime` → `307` redirect to **`/v1/realtime/`**. The trailing slash matters.
- A real WebSocket upgrade against `/v1/realtime/?model=Systran/faster-distil-whisper-large-v3` returns **`HTTP 101 Switching Protocols`**. The endpoint works today.
- speaches implements the **OpenAI Realtime API** shape: `session.update`, `input_audio_buffer.append` (base64 PCM), `input_audio_buffer.commit`, and transcription delta/completed events. Target this, **not** speaches' own `WS /v1/audio/transcriptions`, which is server-specific and would lock us in.

Existing backend facts:

- `src/routes/transcribe.ts` does `await file.toBuffer()` — batch by construction. Leave it working.
- `src/services/transcription/` holds `types.ts` (the `TranscriptionProvider` interface), `factory.ts` (env-driven), and `providers/{base,openai,custom-base-url}.ts`.
- Env today is **single-server**: `TRANSCRIPTION_PROVIDER`, `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_API_KEY`, `TRANSCRIPTION_MODEL` (see `src/config/env.ts`).
- `tests/e2e/local-stt-provider.test.ts` is an opt-in test that already points at `LOCAL_STT_BASE_URL=http://192.168.50.140:8000/v1`. Follow its opt-in pattern for anything needing the live server.
- There is **no** WebSocket dependency yet: no `ws`, no `@fastify/websocket`, no proxy plugin. Fastify 5, routes loaded via `@fastify/autoload`.
- Package manager is **pnpm**. Read `package.json` scripts before running anything.

## What to build

### 1. Multi-server configuration

Today only one transcription server can be configured. Add support for several, without breaking the single-server env.

Suggested shape — an env var holding JSON:

```
TRANSCRIPTION_SERVERS='[{"id":"speaches-lan","label":"Speaches (LAN)","baseUrl":"http://192.168.50.140:8000/v1","model":"Systran/faster-distil-whisper-large-v3","capabilities":["batch","realtime"]}]'
```

Rules:
- If `TRANSCRIPTION_SERVERS` is absent, synthesize a single entry from the existing `TRANSCRIPTION_*` vars so current deployments keep working unchanged.
- Validate at boot and fail fast with a clear message, matching how `factory.ts` already treats a bad `TRANSCRIPTION_BASE_URL`.
- Never return an API key to a client.

### 2. `GET /transcription/servers` — the "available servers" route

Returns the servers the client may use, and what each can do. This is the discovery endpoint the Mac app will call before opening a socket.

- Authenticated, like the other non-health routes.
- Zod schema + Swagger annotations, matching the style in `src/routes/transcribe.ts`.
- Response per server: `id`, `label`, `model`, `capabilities` (`batch` / `realtime`), and whether it is currently reachable if you implement a cheap health probe. **Do not** expose `baseUrl` credentials or keys.
- Keep it honest: if a server is configured but unreachable, say so rather than omitting it silently.

### 3. `WS /transcription/stream` — the proxy

- Add `@fastify/websocket` (server side) and `ws` (upstream client).
- Client connects with a server `id` (query param) and a bearer token.
- **Authenticate before opening the upstream socket.** An unauthenticated socket must be closed with a proper close code, never silently accepted.
- Once authorized, dial the upstream `<baseUrl>/realtime/` (remember the trailing slash) and pipe frames both ways.
- Handle: upstream refuses, upstream drops mid-session, client drops mid-session, and backpressure. A dropped socket must not leak the upstream connection.
- Log through whatever logger the app already uses. Do not add a new logging library.

### 4. The unifying interface

Extend the existing abstraction rather than forking it:
- Keep `TranscriptionProvider` (batch) exactly as it is — its tests must stay green.
- Add a sibling notion for realtime capability, so a server can advertise `batch`, `realtime`, or both, and so a second engine (a streaming Nemotron checkpoint) can be added later without touching route code.
- The route layer must not name a concrete implementation, matching the existing rule that "the route only sees the interface and never names an implementation."

## Constraints

- **Do not break the batch path.** All existing tests must pass.
- Follow existing repo conventions: Fastify autoload routing, Zod schemas, Swagger annotations, the existing error style.
- Add tests. Unit tests for config parsing and the interface; an opt-in live test for the socket, gated on an env var exactly like `tests/e2e/local-stt-provider.test.ts`.
- Run lint and the test suite before you finish. Fix what you break.
- Commit in **commitlint** format, in logical commits, on this branch only.
- **Do not push. Do not open a PR. Do not merge.** The owner reviews first.
- Never mention Anthropic or Claude Code in commit messages.
- Do not edit files outside this worktree — in particular not `/Users/uzi/Developer/whispera-backend` or the Mac app repo.

## Definition of done

1. `GET /transcription/servers` returns speaches with `realtime` in its capabilities.
2. A WebSocket client can connect through the backend, stream audio, and receive transcription deltas from speaches.
3. Existing batch transcription and its tests are untouched and green.
4. Lint clean, tests green, work committed on `feat/realtime-transcription-proxy`.
5. Write `RESULT.md` in the worktree root: what you built, the exact routes and env vars you added, what you tested and how, anything you could not finish, and any decision you want the owner to confirm.

## Start by

Reading `src/services/transcription/types.ts`, `factory.ts`, `providers/custom-base-url.ts`, `src/routes/transcribe.ts`, `src/config/env.ts`, and `tests/e2e/local-stt-provider.test.ts`. Then propose your design in `RESULT.md` before writing the proxy.
