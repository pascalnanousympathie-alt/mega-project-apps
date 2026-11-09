# Parallel project orchestration runbook

## Operating rule
Use one coordinator and separate workstreams. Parallel means independent tasks can proceed at the same time; it does not mean all ChatGPT project chats automatically run in the background.

## Workstreams
1. Mega-project control plane: status ledger, dependency graph, action queue, evidence and CI policy.
2. Nanoumada: AI chat/coding app, provider settings, chat API, login and deploy/preview checks.
3. Nanou Browser: browser-agent service and Android implementation remain separate branches/worktrees.
4. LudoMada: gameplay/3D, backend, Android/Ramus, wallet connectivity, release gates.
5. Mada Commander: MCP/runtime/dashboard/authorization; currently nested in LudoMada worktree, so protect that tree until existing edits are checkpointed.
6. RamiMada, LotoMada and DominoMada: separate app audits and builds; share generic CI/security patterns only after each repository is independently verified.
7. PC-Free/infrastructure: device/tool availability, reproducible setup, runner health and backups.

## Start-of-session gate
For each worktree/repository:
- Read repository URL, branch, HEAD, working-tree status, remotes, default branch and open PRs.
- Record existing uncommitted/untracked files and create a recoverable checkpoint before modifying files.
- Read project instructions (AGENTS.md, README, CI policy, environment examples). Never read or print secret values from .env, tokens, signing keys or credentials.

## Parallel scheduling
- First run independent read-only audits across repositories.
- Then dispatch independent fixes to isolated branches/worktrees.
- Serialize changes to the same repository/file and any operation that depends on another task's output.
- Track dependencies explicitly; do not let a blocked VNC, emulator, quota or deployment account stop unrelated work.
- Limit retries: after a repeated failure, capture logs and change the diagnostic method before another attempt.
- Use available free runners/tools first. If quotas block CI, diagnose and use only an authorized alternate runner; do not weaken required tests.

## Required gates per change
1. Root cause backed by logs, failing test or reproducible behavior.
2. Small patch with no unrelated formatting/rewrite.
3. Lint/typecheck/unit/integration/E2E/build as applicable to the stack.
4. Security scan, secret scan and dependency checks; investigate findings instead of suppressing scanners.
5. Mobile/responsive/accessibility/performance/i18n tests where applicable.
6. Database migrations and rollback plan if schema changes exist.
7. Independent post-change verification and evidence.
8. Draft PR for review; no merge/deployment/production mutation without explicit authorization.

## Status values
- PASS: required checks succeeded and independently verified.
- PARTIAL: some checks passed; one or more required checks/evidence remain.
- BLOCKED: a concrete external prerequisite prevents safe progress.
- UNDIAGNOSED: a failure exists but its root cause has not been proven.
- NOT RUN: no test was executed during this audit.
Never promote PASS based only on a model response, successful build, or unrelated green job.

## Update the control plane
Update PROJECT_STATUS.md after every material test/fix/PR state change. Each entry must include timestamp, repository/branch/HEAD, action, test output or evidence link, result, unresolved risks and next action.

## Previous first actions (2026-11-08; superseded by the 2026-11-09 refresh)

1. **LudoMada FPS acceptance:** use PR #205's exact-head SwiftShader telemetry as a diagnostic sample only. It reports 5.32 FPS, 21 frame intervals and GPU_TIME=NOT_MEASURED; frame P95 is 244.08 ms. Do not claim stable FPS or make another speculative renderer patch. The next valid acceptance requires a sustained, repeatable profile on an authorized Honor 8X/Mali device or equivalent hardware runner, with the same scene/build and preserved telemetry.
2. **LudoMada stacked performance PRs:** review the dependency chain #203 → #204 → #205 and their exact heads/checks as one integration plan. Keep all draft PRs unmerged until an owner reviews the full diff/base and the hardware performance acceptance is met.
3. **Mada Commander deployments:** keep canonical public MCP, auto/fail-closed deployment, personal-controller UI and local controller process as separate components. Auto's 503/ready=false is expected while production DB/OAuth are intentionally absent. Any production DB/OAuth setup requires owner authorization; do not read or change secret values.
4. **Nanou Browser separation:** Android app stays on android-alternative; browser-agent PR #2 is not isolated because it removes the Android CI workflow and changes Android files. Keep it unmerged until the owner selects a separate repository or approved non-Android base. Android CI has no newer branch run than 2026-10-18; use only a supported authorized runner, not an unverified CircleCI configuration.
5. **Nanoumada:** distinguish scheduled stale-issue automation from app CI. Main has no fresh app-CI run; PR #13/#14 preview deployments are READY. Do not label stale-issue PASS as application-test coverage.
6. **RamiMada/LotoMada/DominoMada/PC-Free:** retain the 2026-11-02 main security PASS and 2026-11-01 Android build/rules PR PASS as dated evidence. Do not rerun unchanged suites merely to refresh timestamps; run relevant app gates after a source change or an explicitly authorized dispatch.
7. **mega-project-apps:** status PR #3 exact head 78224bc has executed ACEP and Security PASS. PR #7 already carries the monotonic updated_at fix and passes its exact-head gate. PR #8's executed ACEP failure is in tests/users.test.js but the assertion is missing; review PR #7 as a possible dependency before changing PR #8. Keep both drafts unmerged. PR #8's staging-provider change remains draft and has no deployment authorization.
8. **Capacity and local controller:** 10k-RPS needs an independent load generator plus owner-approved staging. Personal local controller remains unverified; do not spend the remaining Desktop Commander quota or restart noVNC without a newly proven need and explicit authorization.
9. **Control-plane hygiene:** preserve all dirty local worktrees; keep GitHub Actions, CircleCI, Vercel and local-device evidence separate. No status-only CI chase after a documentation append.

## Security and operations
- Keep repository credentials, .env, OAuth tokens, API keys, signing keys, wallet private keys and payment secrets out of logs, prompts, commits and status reports.
- Preserve least privilege and user approval for authentication, payments, wallet settings, production access, merges and destructive operations.
- Do not claim background work is active unless an actual workflow/session has been started and checked.


## Anti-repetition and evidence freshness (mandatory)

- Before diagnosing a failure, read the latest `PROJECT_STATUS.md`, this runbook, relevant conversation history, and prior PR/commit/check-run evidence for that exact failure class. Reuse a documented fix if it remains applicable; do not restart from zero.
- Do not present a previously reported GitHub Actions Billing & plans/spending-limit issue as the current root cause unless the *current run* has a fresh annotation/log or other direct evidence tying it to that cause. Treat older annotations as historical until freshly re-confirmed.
- `runner_id=0`, blank `runner_name`, and `steps=[]` establish that the job did not start. They do not by themselves prove billing, application-test, scanner, Android-build, or repository-code failure.
- For jobs that did start, identify the first failing step and inspect annotations/logs before patching. If logs are inaccessible, record the exact endpoint/error and mark the failure `UNDIAGNOSED`; do not invent a finding or repeat the same test without a different diagnostic path.
- Keep providers separate: GitHub Actions, Buildkite, CircleCI, Vercel, and local Termux results are different evidence sources. A pass in one is not a pass in another.
- After a fix, run targeted and relevant regression checks, then independently re-read the saved file/commit/PR/status. Report only the evidence actually observed. Do not weaken required checks to obtain green status.


## Current first actions (updated 2026-11-09 08:24 EAT)

1. **LudoMada FPS acceptance — BLOCKED:** PR #205's SwiftShader sample is diagnostic only (5.32 FPS, 21 intervals, frame P95 244.08 ms, GPU_TIME=NOT_MEASURED). The latest main runtime-watch is [#42538352161](https://github.com/pascalnanousympathie-alt/LudoMada/actions/runs/42538352161), PASS for canonical/auto MCP health, protocol and OAuth fail-closed behavior; it is not a gameplay or FPS test. Require a sustained, repeatable same-build/same-scene profile on authorized Honor 8X/Mali hardware before any FPS acceptance or speculative renderer patch.
2. **LudoMada stacked performance PRs — BLOCKED:** review #203 → #204 → #205 as one dependency chain. Keep all drafts unmerged until exact heads/base and full diff are reviewed and hardware performance acceptance is met.
3. **Mada Commander deployments — PARTIAL/BLOCKED:** canonical public MCP, auto/fail-closed deployment, Vercel personal-controller UI and local controller device remain separate. The auto project is READY as a deployment but intentionally not application-ready: 8 runtime-error groups/24h on /api/router, Google-start/database_ready HTTP 503; the runtime-watch confirms expected fail-closed behavior. Any DB/OAuth setup requires explicit owner approval; do not read or change secret values. Local Mercia device is OFFLINE even though account quota is 100%.
4. **Nanou Browser separation — BLOCKED/UNDIAGNOSED:** keep Android on android-alternative and agent work separate. Android run #39162120214 and PR #1 run #38790950055 have failed jobs with steps=null and BlobNotFound/404 logs; root cause is UNDIAGNOSED, not a proven Android compile failure. Agent PR #2 still changes Android files and removes Android CI; do not merge until the owner chooses a separate repository or approved non-Android base. No authenticated CircleCI route is available.
5. **Nanoumada — PARTIAL:** main's latest [#42462703700](https://github.com/pascalnanousympathie-alt/nanoumada/actions/runs/42462703700) is scheduled stale-issue automation, not app CI. PR #13/#14 previews are READY; no fresh main app-CI run exists. Keep this distinction in status reporting.
6. **RamiMada/LotoMada/DominoMada/PC-Free — PASS on dated evidence only:** main Security Audits on 2026-11-02 and Android build/rules PR checks on 2026-11-01 remain the latest relevant executed evidence. Do not rerun unchanged suites merely to refresh timestamps; run after a source change or authorized dispatch.
7. **mega-project-apps — PARTIAL/UNDIAGNOSED:** status PR #3's previous exact head `40c39ab8230263aa1351b58a284f7c4b9855e890` ACEP run [#42452775140](https://github.com/pascalnanousympathie-alt/mega-project-apps/actions/runs/42452775140) executed and failed at `npm run ci:gate` → `npm test` → `tests/users.test.js` child exit 1. Source strongly suggests same-millisecond `updated_at` collision; the assertion stack is absent. PR #7 already implements monotonic timestamps plus a fixed-clock regression and its exact-head ACEP/Security checks pass. Review/reuse PR #7; do not duplicate the fix. PR #8 has the same failing test file. Keep GitHub Actions and Buildkite distinct: Buildkite Gitleaks/Trivy exit 1 have no readable logs, while Buildkite ACEP/Semgrep/OSV scans pass; GitHub Security Audit jobs pass except OSV Full Scan skipped. Do not attribute any failure to Billing & plans without fresh exact-run evidence. The current status branch head `b2cd7e477c4c662de2d593693e71edb729fae7db` is documentation-only; do not start a CI chase for this append.
8. **Capacity and local controller — BLOCKED:** 10k-RPS requires an independent load generator plus owner-approved staging. Mercia quota is 100%, but the sole device is OFFLINE (last seen 281h); do not issue device commands until it is online and the task requires them. Do not restart noVNC.
9. **Control-plane hygiene:** preserve dirty local worktrees; keep GitHub Actions, Buildkite, CircleCI, Vercel and local-device evidence separate. No merge, production deployment/promotion, payment/wallet mutation, secret access/rotation, security-gate weakening or destructive action without explicit approval.
