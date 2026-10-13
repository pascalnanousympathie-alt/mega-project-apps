# Operations, Security & Connectivity Master Plan

**Audit date:** 2026-10-13 (UTC)  
**Scope:** LudoMada, DominoMada, LotoMada, RamiMada, mega-project-apps/ACEP, PC-Free, Mada Commander, and relevant ChatGPT integrations.

> This document supplements (does not replace) [MASTER_PLAN_P00_P30.md](./MASTER_PLAN_P00_P30.md). P00–P30 remains the overall delivery plan. This file is the operational snapshot, security backlog, connector inventory and ordered recovery plan. Plugin-directory status is not proof of a working deployment; only live connector responses, workflow runs and inspected artifacts count as evidence.

## 1. Operating architecture and decision gates

### System boundaries
- **Source of truth:** GitHub repositories and commit SHA. Make scoped commits and require CI evidence.
- **Planning/orchestration:** mega-project-apps, orchestration/plugins.registry.json, orchestration/workflows.json, and scripts/plugin-workflow-manager.js.
- **Android release:** repository Gradle builds and APK artifacts; MobSF static APK analysis is a separate manual gate.
- **Web/MCP hosting:** Vercel. Health and authenticated tool-contract checks are required even if a deployment is labelled READY.
- **Database:** Supabase project mada-commander-public-mcp; keep it separate from LudoMada gameplay/wallet data.
- **Runtime backend:** Railway connector is authenticated, but this audit did not find a bound Railway workspace/project.
- **Tracking/telemetry:** Linear for delivery issues; PostHog for runtime telemetry only after events are actually ingested.
- **Design/media:** Figma for design work; Higgsfield/OpenArt for assets when needed. Check credit use and validate 3D assets inside the real GLES renderer.

### Mandatory state flow
**INVENTORY → SCOPE → IMPLEMENT → TEST → SECURITY → ARTIFACT/EVIDENCE → REVIEW → PASS/BLOCKED**

No agent response or green scanner job independently makes a release PASS. Keep production promotion, release signing, payment-provider live switches, production migrations, account access changes and other irreversible steps behind explicit owner approval.

### Protected LudoMada rules
Do not casually edit authoritative game state, turn/reconciliation logic, wallet or ledger, anti-cheat, authentication, or MVola/Airtel/Orange/crypto switches while fixing an unrelated UI, dependency or build issue. Any necessary change in those areas needs focused regression tests plus security and product review. Keep live payment switches OFF unless separately approved.

## 2. Repository and CI snapshot

| Repository | Purpose | Latest baseline Security Audit | Current state / important next work |
|---|---|---|---|
| LudoMada | Android game + Node/PostgreSQL backend + public MCP package | [Run 38367558694](https://github.com/pascalnanousympathie-alt/LudoMada/actions/runs/38367558694) passed on a prior pinned-action commit | 17 Semgrep findings after action pins; 4 Trivy dependency vulnerabilities and 21 OSV advisory hits. Release gate [run 38368393962](https://github.com/pascalnanousympathie-alt/LudoMada/actions/runs/38368393962) was queued at last check. Critical dependency remediation and release/runtime evidence are P0. |
| DominoMada | Native Android game | [Run 38367563943](https://github.com/pascalnanousympathie-alt/DominoMada/actions/runs/38367563943) passed | 1 Semgrep manifest warning for exported launcher activity; validate intent filter and entry-point behaviour, do not blindly remove exported=true. |
| LotoMada | Native Android game | [Run 38367571770](https://github.com/pascalnanousympathie-alt/LotoMada/actions/runs/38367571770) passed | 1 Semgrep manifest warning for exported launcher activity; review safely. |
| RamiMada | Native Android game | [Run 38367567177](https://github.com/pascalnanousympathie-alt/RamiMada/actions/runs/38367567177) passed | 1 Semgrep manifest warning for exported launcher activity; review safely. |
| mega-project-apps | ACEP orchestration + shared project controls | [Security Audit 38368257444](https://github.com/pascalnanousympathie-alt/mega-project-apps/actions/runs/38368257444) passed | ACEP CI [run 38367538312](https://github.com/pascalnanousympathie-alt/mega-project-apps/actions/runs/38367538312) failed inside tests/users.test.js. Current job output identifies child process exit 1 but not the exact failing assertion. Semgrep has 12 findings to triage. |
| PC-Free | Static web/docs project | [Run 38367543334](https://github.com/pascalnanousympathie-alt/PC-Free/actions/runs/38367543334) passed | 18 low-severity Semgrep missing-SRI warnings for externally hosted assets; verify exact asset versions before adding integrity hashes. |

The runs above prove that workflows executed successfully for those commits; they do not prove the code is vulnerability-free. A newer commit pins the Semgrep image, and its run is queued/in progress at the time of this plan; re-check the latest run before using it as release evidence.

## 3. Security tools configured in GitHub Actions

The file .github/workflows/security-audit.yml has been committed to all six repositories. It runs:
- **Semgrep CE:** code and workflow static analysis; JSON report artifact.
- **Trivy:** dependency/secret/misconfiguration filesystem scan; JSON artifact.
- **OSV-Scanner:** dependency advisory scan; SARIF artifact.
- **Gitleaks:** secrets scan including Git history; SARIF artifact.

The actions used by this workflow are pinned to commit SHAs; the Semgrep container tag is pinned to semgrep/semgrep:1.178.0. Reports are currently baseline/report-only for Semgrep, Trivy and OSV so existing builds are not blocked before findings have been triaged. Gitleaks is allowed to fail on an actual secret finding. A successful workflow means the jobs ran; it does not mean all findings are remediated.

### Baseline results inspected
- **Gitleaks:** 0 SARIF findings reported in each of the six repositories in the inspected run.
- **Semgrep after pinning the new workflow's action references:** LudoMada 17 (16 warnings, 1 error); DominoMada 1; LotoMada 1; RamiMada 1; mega-project-apps 12; PC-Free 18.
- **Trivy:** LudoMada reported 4 vulnerable dependency instances in package-lock.json. mega-project-apps reported no findings in its scanned npm lockfile/Dockerfile result sections. Other Android repositories returned no Trivy result entries; because these projects do not currently expose equivalent npm lockfile findings, this is **not** proof that their Gradle dependency graph or APK is clean.
- **OSV-Scanner:** LudoMada reported 21 advisory occurrences across 18 distinct CVE IDs in its npm package-lock.json; other repositories had 0 findings in the inspected OSV SARIF runs. Multiple brace-expansion versions account for repeated CVE occurrences.

### P0 — LudoMada dependency remediation
Trivy confirmed the following affected versions and fixed versions in its output:
1. **CRITICAL:** proxy-addr 2.0.7 → 2.0.8 or later. The published advisory explains that a malformed IPv4-mapped IPv6 trust subnet can make attacker-supplied X-Forwarded-For values appear trusted, undermining IP-based access controls and rate limits. Reference: [CVE-2026-90711](https://advisories.gitlab.com/npm/proxy-addr/CVE-2026-90711/).
2. **HIGH:** deepmerge-ts 7.1.5 → 8.0.0 or later. Recursive object graphs can exhaust the call stack. Reference: [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx).
3. **MEDIUM:** ip-address 10.7.0 → 10.7.1 or later (two CVE records in Trivy output).
4. The broader OSV report also flags moment 2.30.1, brace-expansion 1.1.18 and 5.0.9, csv-parse 4.16.3, handlebars 4.7.9, http-cache-semantics 4.2.0, @grpc/grpc-js 1.14.4, sprintf-js 1.0.3, braces 3.0.3, and joi 17.13.7. Upgrade targets must be checked against each advisory's fixed range; some (notably csv-parse) may require a major-version migration.

**Remediation gate:** open a dependency-only feature branch; update direct/transitive dependencies and lockfile using the package manager, do not hand-edit integrity metadata. Run unit, integration, payment, auth, idempotency, concurrency and build tests. Review the resulting lockfile and a fresh Trivy/OSV report. Merge only after the gates pass. Do not deploy or toggle payment providers as a side effect.

### P1 — Remaining Semgrep findings
- **LudoMada (15 mutable action references):** remaining findings are in older workflows android-apk.yml, android-emulator-test.yml, ci.yml, mada-commander-public-mcp.yml, and release-gate.yml. The new security workflow's action references are pinned; these legacy workflow references still need to be resolved deliberately and re-scanned.
- **LudoMada HTTP finding:** security-lobby.test.mjs uses http://127.0.0.1:3000 for a local test server. Treat the finding as a false-positive candidate only if the test is guaranteed to remain loopback-only; do not globally suppress insecure HTTP checks. Confirm the test cannot reach production.
- **LudoMada Nginx finding:** deploy/vps/nginx.conf is flagged for a possible H2C-smuggling pattern around WebSocket upgrade headers. Review the reverse-proxy and WebSocket behaviour; do not remove upgrade headers blindly.
- **DominoMada/LotoMada/RamiMada:** the finding is the exported .MainActivity with a MAIN/LAUNCHER intent filter. That is commonly necessary for the app's launcher. Verify there are no unintended deep links, exported secondary components or sensitive actions; retain launcher behaviour.
- **mega-project-apps:** six mutable action tags remain in ci.yml, plugin-orchestrator.yml, and production-gate.yml; pin to audited SHAs in a scoped CI-only change. Four Python dynamic-urllib findings in agents/bankr-agent.py, agents/bankr.py, agents/llm_budget.py, and supervisor/gemini_bridge.py require input-scheme/host validation and prevention of file:// or unapproved internal targets before fetching. Review core/contracts.js non-literal RegExp for ReDoS risk, and scripts/test-coverage.js for replacement logic that only replaces the first matching occurrence. Add targeted regression tests before code changes.
- **PC-Free:** 18 SRI warnings on scripts/styles in Compare.html, PC-Free-WEB-ANTIGUA/index.html, docs.html, faq.html, index.html, and quickstart.html. Pin the external asset version first, generate the correct integrity hash and crossorigin attribute, and verify the pages still render. Do not guess hashes.

### P1 — ACEP CI failure
Latest inspected ACEP CI failed at npm run ci:gate because tests/users.test.js exited with code 1. npm ci succeeded, and the wrapper logs show several initial HTTP/wallet/payment tests passing, but the wrapper did not expose the precise failing child assertion in that log. Reproduce npm test in a clean runner, improve failure propagation so the failing assertion/stack is preserved without printing secrets, fix the root cause, then require a green ci:gate. Do not skip tests/users.test.js or lower the gate.

## 4. MobSF workflow installation state

Manual .github/workflows/mobsf-apk-audit.yml workflows have been added to LudoMada, DominoMada, LotoMada and RamiMada. They build a debug APK, start the official MobSF Docker image pinned to v4.5.2, upload the APK to MobSF's API and save the scan JSON/PDF as a workflow artifact. The workflow is deliberately workflow_dispatch only.

**State: configured, not yet executed or validated.** Before triggering it, check available hosted-runner RAM and free disk; the supplied MobSF documentation lists 8 GB+ RAM and 80 GB+ free disk as requirements. If the runner cannot meet them, run this on a dedicated authorized high-capacity runner. Static MobSF results do not replace dynamic analysis; dynamic testing needs a supported rooted emulator/VM, which is not configured here.

## 5. ChatGPT app/plugin connection inventory

The statuses below reflect connector/tool responses and relevant plugin-directory searches from this audit, not a guaranteed exhaustive export of every item in the ChatGPT UI.

| Integration | Verified status | Operational note |
|---|---|---|
| GitHub | Connected | Owner authentication verified; six repositories visible and write permissions present. |
| Vercel | Connected; deployment health mixed | Projects found: mada-commander-public-mcp-auto, mada-commander-public-mcp, and ludomada-commander-control. Recent sampled deployments for the auto project were ERROR; sampled deployments for the canonical MCP and control projects were READY. Check deployment logs and live endpoints before declaring full health. |
| Supabase | Connected | mada-commander-public-mcp reports ACTIVE_HEALTHY in ap-south-1. This does not prove OAuth/MCP health or tenant isolation. |
| Figma | Connected | Confirmed by the owner and plugin directory; no reconnection work is required. |
| Railway | Connector authenticated | No workspace/repository binding was returned in this audit; do not claim a backend project is deployed through Railway. |
| Linear | Connected | Workspace/team Nanou Projet resolves; no Linear projects were found, and GitHub review-diff sync was not proven. |
| Lovable | Connected | Free workspace Nanou's Lovable resolves; 0 projects returned. |
| Replit | Connected | Connector authenticated; 0 apps returned. |
| PostHog | Connected | Active Default project resolves, but ingested_event=false. Runtime telemetry is not verified until the app sends a test event. |
| Higgsfield | Connected | Profile resolves. Some creation actions may consume credits; use only when required and validate exports in the real renderer. |
| OpenArt | Connected | Account is Free with 10 credits at audit time; do not spend credits unless explicitly authorized. |
| Context7 | Connected | Available for current library documentation. |
| Superpowers | Connected | Available for TDD/debugging workflow guidance. |
| OpenAI Developers | Installed/enabled | Platform setup tools are present, but no API key was created or verified in this audit. |
| Opera Browser Connector | Installed, live browser disconnected | list_tabs returned “Browser not connected”. In Opera, enable **Allow AI connection** in the Browser Connector, sign in to Opera, then retest tabs. |
| TRIGGERcmd | Tools present, no computer registered | list_commands returned no computers. Register/activate an authorized computer, then retest. |
| TinyFish | Installed/connected, intentionally excluded | Credit usage is a concern; do not invoke unless the owner explicitly requests it. |
| Codex Security | Not installed | Plugin directory reported installed=false. No cause was verified. Current GitHub Actions scanners provide a baseline, but are not the same product. |
| Remote Desktop Commander | Not probed | Deliberately not used in this audit. Prefer the new MCP/GitHub workflow; only use this if a real blocker cannot be resolved otherwise. |

Relevant uninstalled options that appeared in the limited directory searches (not recommended or needed for the current plan) included GitBook, Azure Cosmos DB, Power BI, Firebase, Dropbox Dash and Runway. Do not install unrelated tools merely to increase the connector count.

## 6. Mada Commander readiness gate

The existing documentation and deployments do **not** establish that Mada Commander is fully ready as a self-sufficient replacement for Desktop Commander. The current evidence is:
1. Vercel exposes three projects; recent samples for mada-commander-public-mcp-auto were ERROR.
2. Supabase project status is ACTIVE_HEALTHY.
3. The public-MCP documentation still names the exact OpenAI domain challenge, Google OAuth, /mcp tool-list/call checks, account/agent pairing, tenant isolation tests and Termux bridge as release gates.
4. The paired Termux agent/Opera bridge was not verified in this run.

Close these items in order: inspect Vercel errors/logs and fix the auto deployment; verify canonical /api/health and schema readiness; configure the exact portal-generated challenge value only in the deployment secret store; test Google OAuth and two-account tenant isolation; run unauthenticated/authenticated MCP initialization and tool-list/call tests; pair the authorized Termux agent; prove project read/write/command boundaries and return a commit-linked test log. Do not invent a domain challenge token, bypass identity verification or route production commands through an unverified local agent.

## 7. Priority backlog and acceptance criteria

### P0 — Security / build blockers
1. **Patch LudoMada dependency advisories:** feature branch, lockfile regenerated by npm, tests/build passed, fresh Trivy + OSV results reviewed. Owner: Senior Developer + Security Auditor.
2. **Diagnose ACEP CI failure:** obtain the real failing assertion from tests/users.test.js; no skipped/bypassed tests; npm run ci:gate passes. Owner: Senior Developer + DevOps.
3. **Diagnose LudoMada release gate queue and latest visual gate failure:** inspect the latest workflow logs and commit SHA; do not promote the release until backend tests, APK build, visual/gameplay QA and release checklist have evidence. Owner: DevOps + Senior Developer.
4. **Triage Ludo Semgrep ERROR and Nginx finding:** prove loopback-only test use; review safe WebSocket reverse-proxy setup. Owner: Security Auditor + DevOps.

### P1 — Hardening / mobile readiness
5. Pin the remaining mutable action references in the existing LudoMada and mega-project-apps workflows using verified SHAs, in CI-only commits; rerun Semgrep.
6. Review all findings in agents/*, supervisor/gemini_bridge.py, core/contracts.js, and scripts/test-coverage.js; add tests for rejected schemes, private/internal destinations, malformed schema patterns and repeated placeholder characters.
7. Review Android exported launcher activities and document why android:exported=true is necessary.
8. Fix PC-Free external asset SRI warnings with version-pinned assets and computed hashes.
9. Run the MobSF manual workflows once a runner meets the required resource profile, then review the APK report artifacts.
10. Fix mada-commander-public-mcp-auto deployments and run authenticated MCP + OAuth + tenant-isolation + Termux-bridge readiness checks.

### P2 — Connector activation and operations
11. Reconnect Opera Browser Connector; verify it with a live list_tabs result.
12. Register a TRIGGERcmd computer only if remote device commands are genuinely needed.
13. Add one PostHog test event from a non-production app build and verify ingestion before enabling runtime analytics gates.
14. Create Linear projects/triage issues from accepted findings; leave unresolved findings unassigned only with a documented reason and review date.
15. Reconcile the registry again after each verified connection/deployment change; statuses must be evidence-backed.

## 8. Roles, evidence and sign-off

- **Project Manager:** dependency order, ownership, due order, blocker tracking.
- **Senior Developer:** code fixes, compatibility, tests and regression coverage.
- **DevOps:** CI, builds, hosted-runner capacity, deployment/health, logs and rollback.
- **Security Auditor:** findings triage, threat model, severity/reachability, dependency review and secrets.
- **Product owner:** requirements and approval for release/signing, payments, production migration, OAuth/identity, account access and irreversible actions.

Each backlog item is **BLOCKED** until the required evidence is attached: commit SHA, exact workflow run, log/artifact, test result and a written triage decision. Do not mark a CVE fixed solely because a version string changed; confirm a fresh scanner run and regression suite.
