# MEGA PROJECT — P00→P30 MASTER PLAN & RESPONSIBILITY MATRIX

## Scope
This master plan governs exactly:
1. LudoMada — existing production/release pipeline; protected
2. DominoMada
3. LotoMada
4. RamiMada
5. ASEP/ACEP Pipeline — cross-project orchestration, evidence, CI and release gates

## Authority and responsibility
- MASTER SUPERVISOR/JUDGE: Gemini — checkpoint-only; GO / CORRECT / BLOCK based on evidence.
- EXECUTION MANAGER: Project Manager agent — owns phase sequencing, dependencies and hand-offs.
- TECHNICAL AUTHORITY: Senior Developer agent — architecture, implementation quality, tests and correctness.
- OPERATIONS AUTHORITY: DevOps agent — runtime, build, CI/CD, deployment, recovery.
- SECURITY AUTHORITY: Security Auditor agent — secrets, auth, validation, abuse controls, supply chain.
- HEAVY REASONING/CODING WORKER: DeepSeek — only when API credit is available/needed.
- FAST WORKERS: Groq/Cerebras/other configured providers — bounded tasks; never override a failed gate.
- HUMAN OWNER: final business/product decisions and irreversible external actions.

## Decision protocol
Each phase:
START → STATE → CHECKPOINT → EXECUTE → TEST → SECURITY → EVIDENCE → REVIEW → PASS/BLOCKED → next phase.
If blocked:
ANALYSE → CORRECT → REBUILD/RETEST → SECURITY → REVIEW.
No PASS without machine-verifiable evidence.

## P00–P30 phases

P00 — Inventory & baseline
- Discover repos, branches, existing commits, APK/build status, blockers.
- Owner: PM; evidence: DevOps.

P01 — Scope & acceptance criteria
- Freeze MVP/product requirements for each project.
- Owner: PM; technical review: Senior Dev.

P02 — Repository & workspace hygiene
- Monorepo/service boundaries, gitignore, scripts, environment separation.
- Owner: DevOps; review: Security.

P03 — Architecture
- Shared core, wallet/auth boundaries, game service boundaries, gateway contracts.
- Owner: Senior Dev; PM validates scope.

P04 — Data model & persistence
- Users, wallets, ledger, games, rooms, transactions, audit records.
- Owner: Senior Dev; Security validates integrity.

P05 — Authentication & authorization
- Identity, sessions/tokens, roles, service-to-service authorization.
- Owner: Senior Dev; Security gate.

P06 — Central wallet & ledger
- Balance, immutable ledger, idempotency, reconciliation interfaces.
- Owner: Senior Dev; Security + DevOps verification.

P07 — Multiplayer gateway
- WebSocket/session lifecycle, rooms, reconnect, authoritative server state.
- Owner: Senior Dev; DevOps load/runtime checks.

P08 — DominoMada core
- Rules, turn engine, online/offline modes, persistence.
- Owner: Senior Dev; PM acceptance.

P09 — LotoMada core
- 3x9 ticket validation, shuffle, draw/win logic, prize accounting.
- Owner: Senior Dev; Security wallet handshake review.

P10 — RamiMada core
- 52+2 deck, groups/runs, turn/discard validation, persistence.
- Owner: Senior Dev; Security integrity review.

P11 — Shared API contracts
- Versioned REST/WebSocket contracts, error schema, idempotency.
- Owner: Senior Dev + DevOps.

P12 — Payment abstraction
- MVola/Airtel/Orange/Binance adapters behind one interface.
- Owner: Senior Dev; Security owns credential/transaction safety.

P13 — Payment reconciliation
- Pending/success/failure states, callbacks/polling, duplicate protection.
- Owner: Senior Dev; Security gate.

P14 — Wallet/game integration
- Entry fees, prizes, commissions, refunds, ledger atomicity.
- Owner: Senior Dev; PM verifies product rules.

P15 — Client/UI integration
- Login, home, lobby, wallet, waiting room, game screens, profile.
- Owner: Senior Dev; PM UX acceptance.

P16 — Localization
- Malagasy/French/English where specified; currency/format consistency.
- Owner: PM; Senior Dev implementation.

P17 — Offline/manual modes
- Local play where specified, deterministic state, protected local records.
- Owner: Senior Dev; Security tamper review.

P18 — Automated unit/integration tests
- Rules, wallet, payments, gateway, persistence, edge cases.
- Owner: Senior Dev; DevOps runs evidence.

P19 — End-to-end tests
- Auth → lobby → game → wallet → payment/reconciliation.
- Owner: DevOps; Senior Dev fixes; Security observes.

P20 — Security audit
- Secrets, authz, injection, validation, replay/idempotency, dependency audit.
- Owner: Security Auditor. Any critical finding = BLOCKED.

P21 — Performance/load/reliability
- Concurrency, reconnects, DB pool, queue/backpressure, resource limits.
- Owner: DevOps; Senior Dev fixes.

P22 — Failure/recovery drills
- Restart, crash, network loss, duplicate payment callback, partial failure.
- Owner: DevOps; Security validates state integrity.

P23 — Build/release reproducibility
- Clean build, versioning, artifacts, signing gates, checksums.
- Owner: DevOps; Security verifies artifact hygiene.

P24 — CI/CD
- GitHub checks, test/build/security gates, deployment rules.
- Owner: DevOps; PM verifies required gates.

P25 — Observability
- Structured logs, health checks, metrics, audit trails, alert conditions.
- Owner: DevOps; Security checks sensitive-data leakage.

P26 — Production/payment readiness
- Provider configuration readiness, environment separation, reconciliation readiness.
- Owner: PM + DevOps; Security approval required.

P27 — Release candidate
- Freeze candidate, run complete regression and evidence pack.
- Owner: PM; all four agents sign their domain review.

P28 — Final independent judge
- Verified external judge reviews only the evidence/diffs/results, not raw endless work.
- Gemini is preferred when available; verified free-tier Groq is the fallback.
- Verdict: GO / CORRECT / BLOCK.
- No verdict can bypass failed tests/security gates.

P29 — Launch & monitored rollout
- Start approved services, health-check, smoke-test, monitor, rollback plan.
- Owner: DevOps; PM coordinates; Security monitors.

P30 — Continuous operations
- Long-running surveillance, incident loop, dependency/security review, controlled improvements.
- Owner: PM + DevOps; Gemini checkpoint judge; all agents remain available.
- Never auto-deploy a risky/irreversible change without the required gate.

## Project mapping

| Phase family | LudoMada | DominoMada | LotoMada | RamiMada | ASEP/ACEP |
|---|---|---|---|---|---|
| P00–P03 | protect + audit | execute | execute | execute | orchestrate |
| P04–P07 | audit existing | execute | execute | execute | gate |
| P08–P10 | protect | P08 | P09 | P10 | verify |
| P11–P17 | payment/release audit | execute | execute | execute | integrate |
| P18–P22 | regression/release gates | execute | execute | execute | evidence |
| P23–P26 | existing release pipeline | execute | execute | execute | CI/security |
| P27–P28 | release checkpoint | candidate | candidate | candidate | final judge |
| P29 | existing automation | controlled launch | controlled launch | controlled launch | rollout manager |
| P30 | continuous release ops | surveillance | surveillance | surveillance | master supervisor |

## Non-negotiable ownership rules
1. PM cannot declare technical PASS.
2. Senior Dev cannot waive Security.
3. DevOps cannot waive tests.
4. Security cannot rewrite product requirements.
5. Gemini cannot invent evidence or override a failed machine gate.
6. Workers cannot directly promote a release.
7. LudoMada remains isolated from experimental changes unless explicitly entering its own phase.
