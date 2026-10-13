# Plugin and Workflow Orchestrator

This directory is the small, version-controlled control plane for the development workflow. It records which integrations are available, which require a user-authorized connection, and what evidence each workflow must produce.

## Commands

Run from the repository root:

```sh
node scripts/plugin-workflow-manager.js status
node scripts/plugin-workflow-manager.js check
node scripts/plugin-workflow-manager.js plan fast-code
node scripts/plugin-workflow-manager.js plan gameplay-qa
node scripts/plugin-workflow-manager.js plan 3d-pipeline
node scripts/plugin-workflow-manager.js plan fast-web-deploy
node scripts/plugin-workflow-manager.js plan backend-deploy
node scripts/plugin-workflow-manager.js plan mada-commander-readiness
node scripts/plugin-workflow-manager.js plan all
```

- `status` displays the checked-in registry snapshot. It is **not a live connection probe**.
- `check` validates registry integrity and workflow references.
- `plan` shows what is ready, blocked on a user connection, dependent on a remote runner, or held for human approval.
- The planner does not execute a plugin, connect an account, change source code, run a deployment, or fabricate evidence.

## Connect integrations

Superpowers and Context7 have been confirmed connected for this session. The remaining optional integrations marked `requires_user_connection` are Codex Security and PostHog. Complete each app's account connection/consent flow from ChatGPT's app/connector settings when available. A suggestion or catalog listing does not mean the integration is connected. Update `plugins.registry.json` only after the connection is actually confirmed; never mark a tool connected merely because it is desired.

A status set to `connected` only records that the operator believes the integration is connected. A workflow is complete only when the relevant connected tool actually executes and returns verifiable evidence during that run.

## Workflow policy

1. Inspect the target repository and current branch before changing code.
2. Make a scoped change on a feature branch and preserve the existing CI gate.
3. Add or update regression tests; investigate failed checks instead of silently retrying all work.
4. Treat generated 3D media as source/reference material until its mesh, transform, texture dependencies, scale, license and performance are verified in the target renderer.
5. A Ramus step is not complete until the remote run produces a commit-linked command, exit code and logs/screenshots that can be inspected.
6. Keep deployment, production database migration, payment-provider live switches, APK publication and release-signing behind an explicit human approval step.
7. Never put tokens, credentials, private keys, user data or raw environment dumps in this registry, logs or pull requests.

## LudoMada invariants

Do not change authoritative game state, turn/reconciliation logic, wallet or ledger invariants, anti-cheat, authentication, or MVola/Airtel/Orange/crypto live-payment switches as a side effect of an unrelated rendering or tooling change. Any required change in these areas needs focused tests and review.

## Current boundaries

This repo can validate the orchestration definitions and display a plan. It cannot itself grant OAuth consent, install an app into ChatGPT, or prove Android/gameplay correctness without the authorized remote runner. Account permissions, available features, and service billing remain controlled by the corresponding provider.
