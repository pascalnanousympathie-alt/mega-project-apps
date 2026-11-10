# Gitleaks: reviewed crypto-ledger test fixtures

The main-branch Security Audit [run 42714362512](https://github.com/pascalnanousympathie-alt/mega-project-apps/actions/runs/42714362512) on commit `3b86e64019dfe2d1945b5d44a09bc25d50f55279` failed in Gitleaks after checkout and scan execution.

The SARIF report contained three `generic-api-key` findings, all in `tests/crypto-ledger.test.js` at lines 25, 51 and 56. The findings point to the `idempotency_key` field passed to `cryptoLedger.reserve` in deterministic unit-test cases:
- line 25: `crypto ledger credits, reserves and settles atomically`;
- lines 51 and 56: `crypto ledger rejects overspending and supports release`.

The original finding commit is `d812c618d544d6755f9203b71ff2548543866320`. The source context identifies these values as test-only idempotency identifiers, not provider credentials or environment-loaded authentication secrets. No matched values are copied into this document or the PR.

The root `.gitleaksignore` contains only the three exact historical fingerprints (commit, file, rule and line). It does not ignore a path, rule, token prefix or future commit. Any changed/new finding remains subject to the normal Gitleaks gate and must be reviewed individually.

If any value is later shown to be a real credential rather than a test idempotency identifier, remove the allowlist entry and follow the incident/rotation process; this narrow allowlist is not a substitute for credential rotation.
