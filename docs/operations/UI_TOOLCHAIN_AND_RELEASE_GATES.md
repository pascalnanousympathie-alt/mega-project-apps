# UI toolchain and release gates (free-first)

**Verified:** 2026-10-22. This is a tool-selection guide, not a claim that every product is installed, connected, or production-ready. Recheck official plans before relying on free quotas.

## Recommended decision

Use **Figma for the reusable design system**, **Google Stitch for rapid visual concepts**, the **existing repository and Desktop Commander/Termux for implementation**, and **Playwright / Android UI tests for repeatable verification**. A generated prototype or a green compile is never enough to declare a UI complete.

## Tool matrix

| Need | Preferred tool | Why / how to use it | Important limits and guardrails |
|---|---|---|---|
| Stable design language across screens | [Figma](https://www.figma.com/pricing/) Starter | Define source-of-truth colors, type styles, spacing, responsive frames, reusable components, UI states and annotated screen handoff. Its Starter plan has free, limited product access and UI kits/templates. | AI credits and some advanced design/prototyping capabilities are limited. Use Figma as a specification and review surface; it does not prove production code works. |
| High-fidelity UI concepts from a prompt or reference | [Google Stitch](https://stitch.withgoogle.com/) | Explore screen compositions and iterations quickly. Google says Stitch can use text/voice and existing code/design files; it can create a shareable link and export screens toward Antigravity or publish through Netlify. | The cited official announcement does not guarantee an unlimited free quota. Check terms at sign-in. Treat generated screens as design concepts, not a replacement for app architecture, backend, security, or tests. |
| Web implementation prototype (optional) | [v0](https://v0.build/pricing) | Useful for isolated web components or screens; current published free plan lists $5 monthly credits and a 7-message/day limit, with GitHub sync. | Credits are limited. Do not spend credits or deploy/overwrite a live project by default. Do not import a generated full app over an existing repository; port only reviewed, targeted components. |
| Alternate web prototype (optional) | [Lovable](https://lovable.dev/pricing) | Useful for quick web-only mockups. Current pricing publishes free build/Cloud grants, with free publishing restricted to invited viewers. | Credit-based. Not required for this workflow; do not consume quota or connect a sensitive repository unless necessary and permission scope is reviewed. |
| Coding assistant | [Cursor](https://cursor.com/pricing) | Free/Hobby has limited Agent requests; local-editor agent work can assist code editing. | Current pricing lists Cloud Agents on a paid plan. Cursor's remote/background agents can run terminal commands and access the internet, so they are not the default free path for sensitive repositories. If used, authorize only the exact repository, use a feature branch, enable privacy protections, give no production secrets, and inspect all changes. |
| Execute code and preserve working state | Existing Desktop Commander + Termux | Already accessible for this environment; Node, npm, Java, Gradle, adb and a Playwright command were detected in the connected Termux shell. Use per-project commands and isolated branches. | Tool presence does not prove each project dependency, emulator, device, deployment, or test is ready. Preserve dirty worktrees and capture the actual command output. |
| Web UI behaviour and visual regression | [Playwright](https://playwright.dev/docs/test-snapshots) | Browser flows plus screenshot comparisons using `toHaveScreenshot()`; pin viewport, locale, test data and rendering environment. Run against the app and repo's lockfile. | A screenshot diff is not automatically a bug or an automatic pass. Inspect diffs, traces, console/network errors and mobile overflow. Update reference snapshots only after intended visual changes are reviewed. |
| Native Android UI stability | [Android UI Automator](https://developer.android.com/training/testing/other-components/ui-automator) and [Android screenshot testing](https://developer.android.com/training/testing/ui-tests/screenshot) | Use the app's current Android UI test stack for navigation, waiting for stable UI, accessibility-visible controls, screenshots and golden/reference comparisons. | Do not add an alpha dependency blindly. Do not call an Android app UI-verified from Gradle compilation or unit tests alone; capture instrumented or real-device evidence. |
| 3D authoring (only if an existing asset needs editing) | [Blender](https://www.blender.org/about/) | Free/open-source 3D modelling, PBR materials, UVs, animation and export; appropriate for editing actual source geometry rather than painting a 2D background. | Blender was not present in the connected Termux PATH during the current check, and is not the primary tool to install on the low-end phone. First use and test existing project assets. |
| Security baseline | [OWASP ASVS 5.0](https://asvs.owasp.org/) + existing Semgrep, OSV-Scanner, Gitleaks, Trivy | Keep authorization/server-side validation, dependency scanning, secret scanning and input validation as explicit release gates. Use repository CI and local tests; retain scanner logs/artifacts. | Existing scanner failures need real logs and diagnosis; do not disable gates or equate a scanner that never started with a clean scan. GitHub's official plan docs state CodeQL/code scanning for private repositories is not included on GitHub Free; don't assume private-repo CodeQL is available without the required plan. |

## Product-specific workflow

### Nanou Browser (web browser-automation service)
1. Confirm the web-service repository/branch and deployed service; do not package an Android APK.
2. Design the control dashboard in Figma/Stitch, then implement only targeted components in the existing web stack.
3. Verify responsive layout, login/authorization, MCP initialize/tools-list and a harmless end-to-end browser session.
4. Use Playwright screenshot/behaviour regression where the current service/test harness supports it. Do not claim a ChatGPT integration until authenticated tool discovery and an actual benign tool call are verified.

### Nanoumada (browser-based AI coding workspace)
1. Keep its Bolt.diy-based web architecture and local dirty changes separate from Nanou Browser.
2. Use the same design tokens and visual regression practice, but test provider settings/chat/stream errors and responsive editor/preview states specifically.
3. Verify API-key handling and server-side provider configuration; never put keys in client code, prompts, screenshots or logs.

### LudoMada (Android Ludo game + backend)
1. Use the existing native GLES2/GLES3 renderer, GLB assets, runtime loader and asset manifest as the source of truth. Do not replace the game board with a generated screenshot or migrate engines without a measured justification.
2. Existing read-only checks on the current Termux working copy passed: `node scripts/check-3d-assets.mjs` reported **28/28**, and `node scripts/check-3d-optimization.mjs` reported `3D_OPTIMIZATION_CONTRACT_PASS`. These prove asset/manifest/optimization-contract consistency only—not visual fidelity, frame rate, animation, APK correctness, or gameplay.
3. Next gate: build the exact current branch, install/run it on the supported target (especially a low-end Android device or a verified emulator), capture Home/board/die/pawn/market screens and interactions, and compare with approved references. Test both supported GLES paths/fallbacks where implemented.
4. Keep rendering/asset edits isolated from authoritative moves, turn logic, settlement, wallet/ledger, auth, and payment provider switches. No real-money/live switch or production deployment as part of a UI change.

### RamiMada / LotoMada / DominoMada
Keep each native app's own package ID, rule set, assets, branch and UI tests. Reuse general visual tokens or test techniques only after review; don't copy complete screens or business logic across games automatically.

### Mada Commander / mega-project-apps / PC-Free
These remain separate control-plane, MCP/remote-command, and infrastructure/static-site scopes. Use their own UI/health/auth tests. Do not share auth tokens, environment files, deployment credentials or databases between projects.

## Universal release gates

- [ ] Confirm repo URL, product identity, branch, HEAD and dirty status; read AGENTS/status/runbook/boundary docs and relevant open draft PRs.
- [ ] Capture an approved reference screen and define the critical screen states before broad visual changes.
- [ ] Implement responsive reusable components and all relevant loading/empty/error/success/disabled states.
- [ ] Run focused functional tests and appropriate screenshot/visual regression tests.
- [ ] Run lint/type/build plus the project's applicable dependency, secret, and code-security checks.
- [ ] Read back the changed files and inspect the diff; confirm no secrets/unrelated work entered.
- [ ] Record actual evidence, target viewport/device and untested cases. Use PASS/PARTIAL/BLOCKED/FAIL/NOT RUN accurately.
- [ ] Draft a PR for review. Do not merge, deploy, change production/auth/payment settings, spend money/credits or enable live providers without explicit authorization.

## Current access notes

- The connected Termux working copy reported a dirty `~/LudoMada` worktree and a separate dirty Nanoumada worktree. Do not reset/clean/stash/rebase/pull/overwrite either.
- The central `PROJECT_STATUS.md`, `PARALLEL_ORCHESTRATION_RUNBOOK.md` and `PROJECT-BOUNDARIES.md` are present in the open draft PR #3 branch (`ops/central-project-status-20261020`) and are **not yet merged to main**. Read these draft files as candidate operational evidence, clearly separated from default-branch status.
- An empty GitHub combined-status response is not a passing test. Check the actual latest check-runs and workflow/job logs before assigning CI PASS.
