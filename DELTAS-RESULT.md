# Synthesized deltas for the realtime transcription proxy

Stacked on `feat/realtime-transcription-proxy` (PR #1) as `feat/synthesized-deltas`.

## What this adds

The realtime proxy (`src/services/transcription/realtime/proxy.ts`) bridges a
client WebSocket to an OpenAI-Realtime-compatible engine byte-opaquely — it
never parses a frame. That is correct for an engine that streams natively, but
every Whisper-family batch engine behind it (speaches included) only ever
produces one hypothesis per utterance, at commit time. A client waiting on
`conversation.item.input_audio_transcription.completed` sees nothing while the
person is still talking.

This PR adds an **opt-in** layer that fixes that for any batch-capable server,
without touching the opaque default path:

- **Config** — `TRANSCRIPTION_SERVERS[].synthesizeDeltas: true`. Valid only
  alongside `batch` (synthesis re-transcribes through the server's own batch
  endpoint, so it needs one). Enforced in `readTranscriptionServers` the same
  way every other cross-field rule in `servers.ts` is: throw at boot, name the
  offending server, never silently coerce.
- **Discovery** — `GET /transcription/servers` now reports
  `realtime.granularity`: `'native-delta' | 'synthesized-delta' | 'utterance'`.
  No provider emits `native-delta` today; the value exists so a future
  streaming-native engine (the brief names a NeMo checkpoint) has somewhere to
  report it without another schema change. A client auto-choosing a server
  should prefer native, then synthesized, then utterance — documented in the
  route's OpenAPI description in `src/routes/transcription/index.ts`.
- **Synthesis** — `DeltaSynthesizer`
  (`src/services/transcription/realtime/delta-synthesizer.ts`), wired into the
  WS route only when a server's config asks for it. It observes
  `input_audio_buffer.append` frames going up and the engine's own frames
  coming down, accumulates the current utterance's PCM16, and every second
  (default) re-transcribes the growing buffer through the server's batch
  provider. Consecutive hypotheses go through LocalAgreement-2
  (`realtime/local-agreement.ts`), and newly agreed text goes out as
  synthesized `conversation.item.input_audio_transcription.delta` frames —
  the exact event slot OpenAI's Realtime protocol reserves for this. Every
  other frame, including the engine's own VAD events and its own `completed`,
  passes through the bridge exactly as it always did; `completed` remains the
  authoritative final and is also this layer's reset signal.

## Why the bridge stayed opaque

`RealtimeBridge` gained three optional constructor hooks —
`observeClientFrame`, `observeEngineFrame`, `onDisposed` — and one new public
method, `sendSynthesizedFrame`. All four are `undefined` unless a server opts
in, at which point the route wires them to a `DeltaSynthesizer` instance via a
hoisted `let synthesizer` (the bridge has to exist before the engine is
dialled, and the synthesizer needs the bridge to inject frames — see
`src/routes/transcription/index.ts`). The observers cannot alter, delay or
drop a frame; they only get to look. Nothing changes for a server that leaves
`synthesizeDeltas` unset — same code path, same behaviour, as it was before
this PR.

## The LocalAgreement-2 algorithm

`advanceLocalAgreement(state, hypothesisText)` in `local-agreement.ts` is a
pure function: word-tokenized hypotheses in, a confirmed-text delta and the
next state out. No audio, no sockets, no timers — that lives in
`DeltaSynthesizer`.

Per step:

1. Tokenize the new hypothesis.
2. If it does **not** start with everything already confirmed, discard it for
   confirmation purposes (keep it only as next round's comparison target).
   This is the "never contradict an emitted prefix" rule from the brief, and
   it is unconditional — no rewind, ever, no matter how different the new
   hypothesis is.
3. Otherwise, take the common-prefix length between this hypothesis and the
   *previous* one. If that reaches further than what's already confirmed,
   confirm up to there and emit the new words as the delta (space-prefixed
   when continuing a non-empty confirmed prefix, so concatenating every
   non-empty delta for an utterance reproduces the confirmed transcript with
   no separator needed).

### Edge cases (table-driven in `tests/services/transcription/local-agreement.test.ts`)

| Case | Behavior |
|---|---|
| First-ever hypothesis | Never confirms anything — `previousHypothesis` is empty, so the common prefix is necessarily empty. This is LocalAgreement-**2** by construction: it takes two hypotheses to agree. |
| Two identical consecutive hypotheses | Confirms the whole thing in one step. |
| Steadily growing hypothesis | Confirms one word "behind" the frontier each tick — each word needs to survive into a second hypothesis before it is safe. |
| Disagreement past the confirmed point (`"brown"` → `"browns"`) | Only the agreeing prefix confirms; the diverging tail is withheld, not guessed at. |
| Rewrite of the *unconfirmed* tail (`"cat"` → `"cap"`) | Completely free — nothing was promised yet, so nothing is contradicted. |
| Hypothesis contradicts an *already-confirmed* prefix | Delta is `''`, confirmed state is untouched, and it stays stuck against further contradicting hypotheses too — there is no safe way to un-say a delta already sent downstream. Recovery only happens via the engine's own `completed` event resetting the whole state. |
| Empty hypothesis mid-utterance | Treated as a contradiction if anything is already confirmed (`""` does not start with a non-empty confirmed prefix) — held rather than treated as a rewind. Handled without special-casing: `tokenize('')` is just `[]`, and the same prefix/common-prefix logic applies. |
| Repeated whitespace | Collapsed identically by `tokenize` on every hypothesis, so it never registers as a disagreement. |

## Bounds and failure handling (`DeltaSynthesizer`)

- **Per-utterance audio cap**: default 60s (`maxUtteranceMs`), computed in
  bytes from the server's own `sampleRate`/`channels`. Once hit, the buffer
  simply stops growing — audio still flows to the engine untouched, synthesis
  just freezes on what it already has for that utterance.
- **One in-flight batch request per session**: a `tick()` that fires while the
  previous one hasn't resolved is skipped outright, never queued.
- **Silent degrade on failure**: a batch error disables synthesis for the rest
  of that session (`disabled = true`, timer stopped) and logs once
  (`loggedFailure` guard) — the underlying session is completely unaffected;
  the client just stops getting deltas and falls back to whatever the engine
  reports at commit time, exactly as if synthesis had never been configured.
- **Stale-response guard**: a `generation` counter is bumped on every reset
  (on the engine's `completed` frame). A batch response for a request issued
  before the bump is dropped rather than applied to the new utterance's
  agreement state.

## Measured: time-to-first-delta vs time-to-final

Run against speaches (`http://192.168.50.140:8000/v1`,
`Systran/faster-distil-whisper-large-v3`, 0.9.0-rc.3) with
`tests/fixtures/spoken-sentence.wav` (~5.2s of speech) paced at 24kHz/50ms
chunks plus 2s of trailing silence, default 1s synthesis tick:

```
timeToFirstDeltaMs: 3380
timeToFinalMs:      6488
deltaCount:         3
concatenated: "The quick brown fox jumps over the lazy dog, whisper a"
finalText:    "The quick brown fox jumps over the lazy dog, whisper a transcription end-to-end test."
```

The first delta landed **~3.1s before** the engine's own
`transcription.completed` — while the fixture was still mid-sentence. The
concatenated deltas are a clean word-level prefix of the final transcript
(checked case/punctuation-insensitively in the test, since the mid-utterance
hypothesis and the engine's own final pass aren't guaranteed to punctuate
identically).

Reproduce:

```bash
LOCAL_STT_BASE_URL=http://192.168.50.140:8000/v1 \
LOCAL_STT_MODEL=Systran/faster-distil-whisper-large-v3 \
pnpm test tests/e2e/local-stt-synthesized-deltas.test.ts
```

## Config reference

```jsonc
{
  "id": "speaches-lan",
  "baseUrl": "http://192.168.50.140:8000/v1",
  "model": "Systran/faster-distil-whisper-large-v3",
  "capabilities": ["batch", "realtime"],
  "synthesizeDeltas": true
}
```

- Requires `"batch"` in `capabilities` — rejected at boot otherwise
  (`TRANSCRIPTION_SERVERS[<id>].synthesizeDeltas requires the "batch"
  capability`).
- Defaults to `false` everywhere, including every entry synthesized from the
  legacy single-server `TRANSCRIPTION_*` env vars — nothing changes for an
  existing deployment that never sets it.
- Surfaces to clients as `realtime.granularity: "synthesized-delta"` from
  `GET /transcription/servers`, alongside the existing `realtime.audio` block
  the client already needs to send the right sample rate.

## Verification

- `pnpm typecheck`, `pnpm lint` — clean.
- `pnpm test` — 517 passing, 3 pre-existing `real-openai-*` failures (missing
  `OPENAI_API_KEY`, unrelated to this change, ignored per the task brief), the
  rest skipped opt-in e2e.
- New unit coverage:
  - `tests/services/transcription/local-agreement.test.ts` — table-driven
    LocalAgreement-2 (11 cases, see table above).
  - `tests/services/transcription/wav.test.ts` — the PCM16→WAV header.
  - `tests/services/transcription/transcription-servers-config.test.ts` —
    `synthesizeDeltas` parsing/validation additions.
  - `tests/services/transcription/realtime-provider.test.ts` — granularity in
    discovery (`resolveGranularity` unit tests plus registry-level
    `describe()` assertions with a fake fetch).
- New live opt-in e2e:
  - `tests/e2e/local-stt-synthesized-deltas.test.ts` — run and passing against
    speaches at `192.168.50.140:8000` (see measurements above).

## PR

<!-- filled in after `gh pr create` -->
