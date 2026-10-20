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

## Current first actions (in order)
1. Protect uncommitted state in ~/LudoMada, ~/NanouBrowser, and ~/projects/nanoumada; inspect diffs and back up before any synchronization.
2. Diagnose latest CI test failure in Nanoumada and Android CI failure in Nanou Browser.
3. Retrieve scanner job output for mega-project-apps, LudoMada, RamiMada, LotoMada and DominoMada; separate real findings from scanner/network/runtime failures without disabling gates.
4. Review current open PRs and their full required checks rather than merging any.
5. Synchronize local games against remote branches only after checkpointing and verifying the exact repository/branch.
6. Resume work in independent tracks while noVNC remains parked until explicit instruction.

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
