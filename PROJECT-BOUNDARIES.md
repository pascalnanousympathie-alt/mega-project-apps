# Mega-project repository and deliverable boundaries

**Purpose:** this file prevents project identity, delivery format, CI recipe, hosting, and credentials from being inferred from stale files or another project's setup. Read it before starting work in any linked repository. The latest explicit user request narrows the scope further.

## Project matrix

| Project/repository | Product identity and primary deliverable | Default verification | Never assume/do by default |
|---|---|---|---|
| **Nanou Browser** (`nanou-browser`) | TinyFish-style **browser automation website/service**: control page `/`, hosted Playwright Chromium service, authenticated remote MCP at `/mcp`, intended to be callable from a compatible ChatGPT account | Agent Service tests, syntax, Docker/Render config, live HTTPS health/auth/MCP `initialize` + `tools/list`, harmless browser session and navigation smoke | **Do not build/package/install an APK.** `app/` and Gradle are legacy/experimental. Do not call it ChatGPT-connected until a supported account completes tool discovery and a live tool call. Target Render free preview unless explicitly changed; do not use Nanoumada Vercel or LudoMada Railway. |
| **Nanoumada** (`nanoumada`) | **Browser-based AI coding workspace/web app** based on Bolt.diy, with provider settings, code editing and project preview | Web dependency lockfile, tests, typecheck, production web build and browser UI/API smoke | No Android APK or native mobile release by default. It is not Nanou Browser and does not own the browser-agent MCP deployment. Preserve the upstream Bolt.diy license/attribution. |
| **Mada Commander** (`LudoMada` subdirectory / its MCP-related deployment) | Separate web UI + custom MCP/control-plane and authorized local bridge for developer/device workflows | API/UI health, MCP handshake/tool listing/calls, OAuth, token boundary, tenant isolation and local-bridge authorization | Do not treat Nanou Browser's MCP as Mada Commander or merge credentials, Supabase tables or deployments across them. |
| **LudoMada** (`LudoMada`) | Four-player Ludo Madagascar **Android game + backend API/database**, including wallet/gameplay services | Game/backend tests, Gradle build when scoped, visual/gameplay evidence, backend contract/security tests | Protect ledger, auth, anti-cheat and real-money switches; do not enable live mobile-money/crypto/payment paths as a side effect. |
| **RamiMada** (`RamiMada`) | Android game | Targeted tests, Gradle test/build, APK checks when the task/release needs a package | Do not copy LudoMada payment/game logic without explicit scope and tests. |
| **LotoMada** (`LotoMada`) | Android game | Targeted tests, Gradle test/build, APK checks when the task/release needs a package | Do not confuse its repository, package ID, signing config or rules with RamiMada/DominoMada. |
| **DominoMada** (`DominoMada`) | Android game | Targeted tests, Gradle test/build, APK checks when the task/release needs a package | Keep game state, package identity and release configuration independent. |
| **mega-project-apps / ACEP** (`mega-project-apps`) | Cross-project orchestration, CI, runbooks, project registry and evidence; **not** the user-facing Nanou Browser or Nanoumada product | Node/Python tests, orchestration/registry consistency, security checks and repo-scope validation | Never run destructive/global changes across repositories just because they appear in the same manifest. Do not change protected LudoMada sources through the coordinator. |
| **PC-Free** (`PC-Free`) | Public website/static content and documentation | Web/build/link/content checks and security checks relevant to static assets | Do not build an APK unless the owner explicitly changes this project scope. |

## Required preflight and decision rules

1. Identify the exact repository, branch, commit SHA, PR, and working-tree state before editing. Preserve uncommitted or unrelated work; use an isolated worktree for CI and cross-repository changes.
2. Read the target repository's `AGENTS.md` and `README.md`, then check this matrix. If a legacy directory, old PR title, memory note, workflow name or available tool contradicts the explicit current request, follow the request and update the stale instruction that caused the mismatch.
3. Decide the requested output format from the task and project's explicit acceptance criteria. The presence of Gradle files alone is not authorization to build an APK. The presence of `Dockerfile` alone is not proof of a public web deployment.
4. Keep code, CI recipe, hosting, credentials, package IDs, environment variables and secrets scoped per repository. Never route Nanou Browser through Nanoumada's Vercel project or LudoMada's Railway service.
5. Do not describe an MCP integration as callable from ChatGPT until the account/plan supports custom MCP connections, a public HTTPS endpoint is verified, the bearer-authenticated `initialize` and `tools/list` succeed, and a harmless tool call succeeds. A local health check, unit suite, or GitHub green badge is not a live integration proof.
6. For CI failures, inspect provider, run event, branch/SHA, runner allocation, steps and logs before retrying. Do not repeat a no-log allocation failure blindly. Use the repo's configured independent runner recipe and keep failure evidence.
7. Before deployment or other external side effects, verify the intended host and account, secret handling, free/paid tier, auto-deploy behaviour and rollback. Do not start a paid trial, spend credits, merge, release-sign, run a production migration, or enable payment switches without the required owner authorization.
8. Every completion report lists what changed, the exact commit, actual tests, deployment/connection evidence, what remains unverified and the single next action. Never label an unverified task PASS.

## ChatGPT/custom MCP limitation

An external remote MCP service does not automatically become a tool in the current ChatGPT conversation. Check current OpenAI account/workspace plan eligibility and configure the app/connector in ChatGPT; see the official [custom MCP connection guidance](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt). Do not pretend a normal ChatGPT subscription is an API key, and do not attempt to bypass account/plan restrictions.
