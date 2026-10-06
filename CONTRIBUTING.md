# Contributing

Thanks for helping. Before you open a pull request:

- Run `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D warnings`
  and `cargo test --workspace`. CI runs the same checks.
- Keep the server default-closed: no route may skip account or device auth
  except `/v1/health`.
- Never log secrets, bearer tokens, APNs keys, full APNs device tokens or relay
  ciphertext.

## Contributor License Agreement (CLA)

The project is dual-licensed: AGPL-3.0 for everyone, plus commercial licenses
sold by the copyright holder (see [COMMERCIAL.md](COMMERCIAL.md)). To keep that
possible, every contributor must sign a CLA that grants the copyright holder
the right to relicense their contribution. You keep the copyright to your work.

We will ask you to sign the CLA on your first pull request; it cannot be merged
until it is signed.
