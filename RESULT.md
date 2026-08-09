# Realtime transcription proxy — result

Branch `feat/realtime-transcription-proxy`, 7 commits on top of `4c10f05`.
Nothing pushed, no PR, no merge. 2,889 insertions, 0 deletions — the batch path
is untouched line for line.

**Definition of done: all five met.** `GET /transcription/servers` returns
speaches with `realtime` in its capabilities; a WebSocket client streams audio
through the backend and gets a real transcript back from speaches; batch and its
tests are unchanged and green; lint, typecheck and build are clean.

One thing needs your eyes: **I changed a file on the speaches container** — you
approved it mid-run, but it is the only change outside this worktree, so it is
written up in full at the end.

---

## Two verified facts that contradict the brief

Both re-checked from this Mac against `192.168.50.140:8000`, twice — once by a
separate investigation, once directly.

### 1. The WebSocket route has **no** trailing slash

The brief says to dial `<baseUrl>/realtime/` and "remember the trailing slash".
That is true of the plain-HTTP `GET /v1/realtime`, which 307s to `/v1/realtime/`,
but it is **backwards** for the upgrade:

| URL | handshake |
| --- | --- |
| `ws://…/v1/realtime?model=…` | **101 Switching Protocols** |
| `ws://…/v1/realtime/?model=…` | **HTTP 500**, socket closed 1006 |

The redirect does not apply to the WS route. The proxy dials `<baseUrl>/realtime`
by default; the path is per-server configurable (`realtimePath`) so an engine
that does want the slash needs no code change. The fake engine in the tests
answers HTTP 500 on the slashed form, exactly as speaches does, so a regression
here fails a test rather than only failing in production.

### 2. speaches' realtime transcription was broken — root-caused and fixed

The socket, the session handshake and the VAD all worked. The transcription did
not: `input_audio_buffer.committed` was followed ~3 ms later by
`{"error":{"message":"Not Found"}}` and a 1006 drop. Three milliseconds is far
too fast for inference, and `POST /v1/audio/transcriptions` on the same server
returned the correct transcript, so it was never a model or audio problem.

Cause, confirmed in the container's own logs: speaches' `get_transcription_client()`
builds an in-process ASGI client when `LOOPBACK_HOST_URL` is unset, but then
interpolates that same unset value into the SDK's base URL, producing the
literal string `None/v1` — a *relative* URL that httpx joins onto its own base:

```
POST http://test/v1/None/v1/audio/transcriptions "HTTP/1.1 404 Not Found"
```

Fixed by setting the variable (details at the end). Before the fix the live test
failed on the transcript assertion and passed everything else; after it, all
five pass.

---

## Protocol notes that shaped the design

Measured on the wire, not assumed:

- **Everything is text JSON**, both directions. A binary frame kills the session
  instantly. The proxy preserves the text/binary flag per frame rather than
  normalising, so it never converts a client's text frame into a session-killer.
- **Audio is 24 kHz** raw PCM16 mono LE, base64'd — not 16 kHz. Sending 16 kHz
  is *not rejected*; speaches time-compresses it (a 5.16 s clip reports
  `audio_end_ms 4039`). This is a client concern, so the discovery endpoint
  states the format rather than leaving the Mac app to discover it.
- **No subprotocol may be forwarded.** speaches accepts a `Sec-WebSocket-Protocol`
  offer but echoes none back, which makes a conformant client abort with 1006.
- **Server VAD is always on** and auto-commits; `input_audio_buffer.commit` is
  optional and VAD cannot be disabled. Nothing in the proxy depends on either.
- **The transcription model must be overridden by the client.** `session.created`
  advertises `Systran/faster-distil-whisper-small.en`, which is not installed on
  that box. The proxy does not rewrite frames, so the client sends `session.update`.

---

## What I built

### The unifying interface

`TranscriptionProvider` (batch) is byte-for-byte unchanged. Streaming gets a
sibling rather than a reinterpretation, because request/response and a live
session are genuinely different shapes:

```ts
interface RealtimeTranscriptionProvider {
  readonly name: string;
  connect(options, listeners): Promise<RealtimeTranscriptionSession>;
}

interface RealtimeTranscriptionSession {
  readonly provider: string;
  readonly open: boolean;
  readonly bufferedBytes: number;      // the proxy's backpressure signal
  send(frame: { data: string | Buffer; isBinary: boolean }): void;
  pause(): void; resume(): void;
  close(code?, reason?): void;
}
```

Frames are **opaque on purpose**. The OpenAI Realtime event shape is the contract
between the Mac app and the engine; the proxy's job is to carry it faithfully,
not to understand it. A streaming Nemotron checkpoint implements
`RealtimeTranscriptionProvider` and does its translation internally — no route
code changes.

`TranscriptionServerRegistry` sits above both interfaces and is what the routes
hold. It resolves a server id to a `TranscriptionProvider` or a
`RealtimeTranscriptionProvider`, so the route layer never names a concrete class.

| File | Role |
| --- | --- |
| `src/services/transcription/servers.ts` | Multi-server config parsing and validation |
| `src/services/transcription/registry.ts` | Resolves ids to interfaces; liveness probes |
| `src/services/transcription/realtime/types.ts` | The streaming interface |
| `src/services/transcription/realtime/openai-realtime.ts` | Dials any OpenAI-Realtime engine |
| `src/services/transcription/realtime/proxy.ts` | `RealtimeBridge` — one proxied session |
| `src/routes/transcription/index.ts` | Both routes |

### Routes added

**`GET /transcription/servers`** — authenticated, Zod schema, Swagger-annotated
under the existing `transcribe` tag.

```json
{ "servers": [ {
  "id": "speaches-lan", "label": "Speaches (LAN)",
  "model": "Systran/faster-distil-whisper-large-v3",
  "capabilities": ["batch", "realtime"],
  "default": true, "status": "online", "detail": null,
  "batchProvider": "openai-compatible",
  "realtime": {
    "protocol": "openai-realtime",
    "path": "/transcription/stream?server=speaches-lan",
    "audio": { "encoding": "pcm16", "sampleRate": 24000, "channels": 1, "transport": "base64-json" }
  }
} ] }
```

- No `baseUrl`, no `apiKey`, ever — asserted by a test that greps the serialised
  response for both.
- Liveness comes from a 2 s-timeout `GET <baseUrl>/models`, cached 10 s.
- A configured-but-unreachable server is reported as `offline` **with a reason**,
  never omitted: to a client, an omitted server is indistinguishable from one
  that was never configured.
- The stock OpenAI entry reports `unknown` rather than being probed. Probing it
  needs a live credential and a billable round trip, and a 401 there would read
  as "offline" — worse than admitting ignorance.

**`WS /transcription/stream?server=<id>&model=<optional>`** — authenticated.

- Auth is a `preHandler` on the upgrade request, so an unauthenticated client is
  refused with **HTTP 401 and never reaches a WebSocket at all**. Tested,
  including that the engine is never dialled for such a request. This is stronger
  than the brief's "closed with a proper close code".
- Later refusals close with an application code plus an error frame in the
  engine's own envelope, so a client needs only one error path: **4404** unknown
  server, **4400** server cannot stream, **1011** engine failed/unreachable,
  **1013** a peer could not keep up.
- Unrecognised query params are forwarded to the engine; `server` and `model` are
  consumed by the proxy and cannot be smuggled through.
- The client's bearer token is never forwarded upstream — the engine gets the
  server's own configured key.
- Logs go through `app.log` (pino). No new logging library.

### Failure and lifecycle handling

Each of these has a test:

| Case | Behaviour |
| --- | --- |
| Upstream refuses the upgrade | Error frame + close 1011, HTTP status in the message |
| Upstream not listening | Same, after a 10 s handshake timeout |
| Upstream drops mid-session | Client closed with the engine's code, sanitised |
| Client drops mid-session | Engine session closed — no leaked connection |
| Client killed abruptly | Same |
| Client drops *during* the upstream handshake | The session is closed the moment it arrives |
| Frames sent before the upstream is ready | Queued in order, flushed on attach; bounded |
| Either peer backs up | Source paused above 4 MiB, resumed below 1 MiB, abandoned after 30 s |

Two subtleties worth flagging, both found by tests failing:

- **`ws.close()` does not resume a paused socket.** It waits for the peer's close
  frame before ending the socket, and reading is what a pause stops — so a socket
  parked by backpressure would hang until ws's 30 s close timer. `dispose()` now
  resumes before closing.
- **An engine that vanishes yields close code 1006**, which RFC 6455 forbids
  putting on the wire. Codes are sanitised to 1011 before being forwarded, so the
  client still gets a clean close instead of a protocol error.

---

## Environment variables

One added: **`TRANSCRIPTION_SERVERS`**, a JSON array. Declared in
`src/config/env.ts` and documented in `CLAUDE.md`.

| Field | Default | Notes |
| --- | --- | --- |
| `id` | — | **Required**, unique. What the client passes as `?server=`. |
| `label` | the `id` | Human-facing name for a server picker. |
| `baseUrl` | AI SDK resolution | OpenAI-compatible root. Must be `http(s)`. |
| `apiKey` | falls back to `OPENAI_API_KEY` | Per-server override. Never returned to a client. |
| `model` | `whisper-1` | Model id. |
| `capabilities` | `["batch"]` | `batch`, `realtime`, or both. |
| `realtimePath` | `/realtime` | Appended to `baseUrl` for the upgrade. |

```bash
TRANSCRIPTION_SERVERS='[{"id":"speaches-lan","label":"Speaches (LAN)","baseUrl":"http://192.168.50.140:8000/v1","model":"Systran/faster-distil-whisper-large-v3","capabilities":["batch","realtime"]}]'
```

**No existing variable changed meaning.** When `TRANSCRIPTION_SERVERS` is absent,
one entry is synthesised from `TRANSCRIPTION_PROVIDER` / `TRANSCRIPTION_BASE_URL`
/ `TRANSCRIPTION_API_KEY` / `TRANSCRIPTION_MODEL`, reproducing current behaviour
exactly. Validation failures throw at boot with the same voice as the existing
`TRANSCRIPTION_BASE_URL` errors — bad JSON, missing id, unknown capability,
duplicate id, non-http URL, and unknown fields (so a `bseUrl` typo is not
silently ignored).

One deliberate limitation: **the synthesised legacy entry advertises only
`batch`.** Nothing in the old env says an endpoint speaks the Realtime API, and
guessing would make the discovery route lie. To stream, declare
`TRANSCRIPTION_SERVERS`.

---

## What I tested, and how

```
pnpm lint        clean
pnpm typecheck   clean
pnpm build       clean
pnpm test        491 passed | 39 skipped | 3 pre-existing failures
```

The 3 failures are `tests/e2e/real-openai-{chat,recipe-execute,transcribe}.test.ts`,
which throw `OPENAI_API_KEY is required` in `beforeAll`. They fail for want of a
key, not for anything in this branch. **68 new tests**, all passing.

**Unit** — config parsing (19 tests): the brief's exact `TRANSCRIPTION_SERVERS`
value, every legacy fallback path, and every validation failure. Registry and
provider (27 tests): URL construction, the no-trailing-slash rule, close-code
sanitisation, probe caching, and that the client-facing view contains neither
the base URL nor the key.

**Proxy** (20 tests) — a real client socket against a real listening Fastify app
in front of a real upstream WebSocket. `app.inject()` cannot express an upgrade,
so nothing here is mocked. The fake engine mirrors what the live server actually
does, including the HTTP 500 on the slashed path. Covers auth refusal, unknown
and batch-only servers, unreachable engines, relay in both directions, ordering
under a 20-frame burst, frames sent before the upstream was ready, and all four
teardown orders.

**Live, opt-in** (5 tests) — `tests/e2e/local-stt-realtime.test.ts`, gated on
`LOCAL_STT_BASE_URL` and *skipping* rather than throwing when unset, exactly like
`local-stt-provider.test.ts`. It parses the fixture WAV by walking its chunks
(the fixture has an `FLLR` padding chunk, so the usual "skip 44 bytes" shortcut
would feed the engine garbage) and resamples 16 kHz → 24 kHz.

```bash
LOCAL_STT_BASE_URL=http://192.168.50.140:8000/v1 \
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
npx vitest run tests/e2e/local-stt-realtime.test.ts
```

Against the live server, all five pass:

```
✓ advertises the live server as realtime-capable and reachable
✓ carries the engine session handshake through the proxy
✓ round-trips a session.update to the engine and back
✓ streams audio and gets the engine voice-activity events back
✓ delivers the transcript the engine produced          7645ms
```

The last one asserts the real transcript — "quick brown fox", "lazy dog" — came
back through the proxy from speaches. The VAD test asserts `audio_end_ms > 4500`
for a 5.16 s clip, which is what would catch a sample-rate regression: at 16 kHz
the same audio reports ~4039 ms rather than failing outright.

I also re-ran the **batch** live suite after restarting the container, to be sure
that path still works: 3/3 pass.

---

## The one change outside this worktree

You approved this mid-run. Recording it precisely because it is infrastructure,
not code, and it is the only thing I touched outside the worktree.

**Host:** ai-proxmox `192.168.50.129` → LXC **CT 137** (`speaches`, `192.168.50.140`).
**File:** `/opt/speaches/docker-compose.yml`.
**Backup taken:** `/opt/speaches/docker-compose.yml.bak.pre-loopback`.

Added to the `whisper` service:

```yaml
    environment:
      LOOPBACK_HOST_URL: http://localhost:8000
```

Then `docker compose up -d`. The container was recreated (a few seconds of REST
downtime). **No image pull** — the existing `latest-cuda` image was reused, so no
version bump. The `hf-cache` volume survived, so no model re-download.

To revert: `cp docker-compose.yml.bak.pre-loopback docker-compose.yml && docker compose up -d`.

Note the value is scheme+host+port only — speaches appends `/v1` itself, so
`http://localhost:8000/v1` would produce `/v1/v1/...`.

The same latent bug exists in speaches' `get_speech_client()` (TTS); this fix
covers it too, though CT137 serves no TTS.

---

## Decisions I'd like you to confirm

1. **I fixed the speaches container rather than working around it.** The
   alternative was a proxy that provably could not deliver a transcript. Flagging
   again in case you want that container pinned or managed elsewhere.
2. **`realtimePath` defaults to no trailing slash**, contradicting the brief.
   I'm confident — measured twice — but it is the brief's one explicit
   instruction I did not follow.
3. **The legacy single-server env never advertises `realtime`.** Honest, but it
   means an existing deployment gains nothing until it declares
   `TRANSCRIPTION_SERVERS`. Say the word if you'd rather infer `realtime` for
   `TRANSCRIPTION_PROVIDER=custom`.
4. **`POST /transcribe` still uses `createTranscriptionProvider()`**, not the
   registry, and so always uses the legacy env — it has no `?server=` selector.
   That kept the batch path and its tests untouched, as instructed. Routing batch
   through the registry too is a natural follow-up, but it changes behaviour, so
   I left it out.
5. **The WebSocket route is not rate-limited.** `@fastify/rate-limit` is disabled
   under `NODE_ENV=test` and its interaction with an upgrade request is untested;
   I did not want to add an unverified failure mode to the auth path. Worth
   adding deliberately if you expect abuse.

## Not done

- **Nothing on the Mac app side.** The brief scoped that to "then get the
  WebSocket connected on the front end"; this worktree is backend-only and I was
  told not to touch that repo. `realtime.path` and `realtime.audio` in the
  discovery response are there so the client needs no hardcoded knowledge.
- **`@fastify/websocket` is registered globally** with a 1 MiB `maxPayload`
  (a 100 ms audio frame is ~6 KB, so this is generous). Only upgrade requests are
  affected; every HTTP route behaves as before.
- **No metrics or session-duration limits.** speaches caps a session at 30 min
  server-side; the proxy imposes nothing of its own.
