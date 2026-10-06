# Legacy TypeScript backend (archived)

This directory holds the original Fastify/TypeScript Whispera backend as it was on
`main` at `5ccb95c`. It is **archived reference only**: it is not built, tested or
deployed by CI any more, and nothing at the repository root depends on it.

The active backend is the Rust workspace at the repository root (see `../README.md`).
Behaviour worth keeping from the TS code and its open PRs (transcription server registry,
LocalAgreement-2 synthesized deltas) has been ported, with the same test cases, to
`crates/stt`.

`ci/test.yml` is the former GitHub Actions workflow (TS + Postgres), kept for reference.
