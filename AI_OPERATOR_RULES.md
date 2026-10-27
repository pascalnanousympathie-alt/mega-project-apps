# AI Operator Rules — Cross-project continuity

These rules are the default operating procedure for work on Mada Commander and the related Mega-Project apps. Apply them before proposing navigation or setup steps.

## Existing personal MCP comes first

1. **Distinguish private use from public directory publication.** The user's existing personal MCP server/connector and a public OpenAI Plugin/App Directory submission are different workflows. Do not conflate them.
2. When the request is to continue using or repair the user's **existing personal MCP**, first inspect the currently available connected tools, server health, authentication status and recent tool history; then use the existing authorized MCP/device integration to make progress.
3. Do **not** redirect the user to OpenAI Platform plugin upload, public submission, public-directory developer identity verification, app listing, or a new plugin/package just to use an existing personal MCP. Only discuss those steps when the user explicitly requests public publication or evidence shows public submission is the current goal.
4. Do not say that a private personal MCP requires billing, payment, paid API credits, or public developer verification unless current authoritative evidence specifically establishes that the particular desired action requires it. Public submission identity verification is not proof of a billing requirement.
5. Never recreate an already-existing personal MCP or re-upload its ZIP as a substitute for diagnosing why it is not callable in the current ChatGPT surface. First establish which surface/plan/permission or connector path is actually blocking it and use the already available route where supported.

## Tool use and diagnosis

6. Prefer live, read-only status checks before actions. Check the exact tool/account/device and current quota. If one connected Desktop Commander account is depleted or nearly depleted, do not infer that every account/device is offline; prefer the available low-cost GitHub, Vercel, Opera Browser Connector or other already-connected tools as appropriate.
7. Use Opera Browser Connector and Desktop Commander when they are online and the action they expose is supported. Do not tell the user to repeat manual steps on a computer when the user is operating from an Android phone and an authorized tool can perform the step.
8. Diagnose the failing layer before proposing a fix: (a) personal MCP server/endpoint, (b) ChatGPT connector registration/authentication/permission/plan, (c) optional public-directory submission. Report exactly which layer was tested and what evidence was returned.
9. Do not repeat the same failed attempt without new diagnostic evidence. Never claim success based solely on a deployment being READY, an upload being prepared, or a tool-call request being accepted; verify the resulting state.
10. Preserve existing work and credentials. Do not reset/clean/stash/rebase/overwrite dirty worktrees, expose secrets, change billing, change production configuration, merge PRs, or deploy without explicit authorization and appropriate safeguards.

## User experience

11. The user prefers direct execution through connected tools, phone-compatible paths, root-cause fixes and concise evidence-based status. Do not re-ask for already provided facts or blame billing without current evidence.
12. If an operation is genuinely blocked, name the exact missing capability or authorization, distinguish it from unrelated requirements, and continue any independent work that can safely be completed.

## Mada Commander verification record — 2026-10-27

For the currently deployed `mada-commander-public-mcp` service, the following read-only checks were observed from the paired Termux device:

- `GET /api/health` returned HTTP 200 and `ready=true`. Database, Google OAuth, OAuth client mode, redirect allowlist, CIMD, and schema checks were true. `domainChallengeConfigured=false` was also reported.
- The OAuth authorization-server metadata endpoint returned HTTP 200 and advertises authorization-code plus refresh-token grants and the `mada:workspace` scope.
- An MCP JSON-RPC `initialize` request returned HTTP 200; `tools/list` returned HTTP 200 and advertised `mada_agent_status`, `mada_list_projects`, and the other registered tools, each declared with OAuth2 scope `mada:workspace`.
- An unauthenticated `tools/call` to read-only `mada_agent_status` returned HTTP 401 with `WWW-Authenticate` and the protected-resource metadata URL. This is expected authentication enforcement; it is not proof that the MCP server is down.
- The current ChatGPT conversation's available tool inventory does not include the `mada_*` tools. The user's existing private plugin records are present in Plugin Creator, but those records do not by themselves make the MCP tools available to this conversation.
- Official current OpenAI documentation states developer mode is unavailable on the Free plan; custom MCP apps are supported on the web in eligible plans, while the full write-capable MCP beta is limited to Business/Enterprise/Edu. Source: https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt and https://chatgpt.com/pricing/.

### Interpretation and required next action

- Do not confuse `domainChallengeConfigured=false` with the private MCP's runtime health. The domain challenge relates to the separate OpenAI public app/plugin submission flow; it is not the reason the MCP protocol initialize or tools/list requests failed (both succeeded).
- The proven blocker for using `mada_*` as native tools in the current chat is that the tools are not injected into this session, and the observed unauthenticated tool call is correctly rejected with 401. Do not bypass OAuth, impersonate ChatGPT's OAuth client, request or expose tokens, or misstate the server as broken.
- Do not send this Free-plan user back to public plugin submission, paid API billing, or identity verification as a way to repair private MCP connectivity. Keep using supported, already-authorized direct tools for tasks where available; when explaining a hard platform limitation, distinguish it from the healthy server and state only the observed requirement.
## OAuth/MCP compatibility checks

13. When maintaining an OAuth-protected MCP server, inspect both /.well-known/oauth-authorization-server and /.well-known/oauth-protected-resource. If the authorization server issues refresh tokens, verify that discovery advertises offline_access (or the equivalent refresh scope) and that authorization requests can accept it while still requiring the server's actual resource/tool scope.
14. Keep refresh continuity separate from authorization: offline_access must never replace or broaden the required mada:workspace scope. Reject unknown scopes and requests that omit the required resource scope; public tool securitySchemes should continue to declare only the actual tool permission.
15. Test the exact MCP layers separately: health, initialize, tools/list, OAuth metadata, authorize/consent, token exchange and refresh, then authenticated tools/call. An expected unauthenticated 401 is an auth-enforcement result, not server downtime.
16. Treat GitHub Actions jobs with runner_id=0 and steps=[] as pre-runner failures, not failing tests or scanner findings. If the log endpoint returns BlobNotFound/404, keep the cause UNDIAGNOSED until a real annotation or another authorized diagnostic route exposes it; do not assign a billing cause from historical evidence.

## GitHub Actions pre-runner failure escalation

When a GitHub Actions job has `runner_id=0`, blank `runner_name`, `steps=[]`, and no log blob:
1. Fetch the exact run metadata and attempt-specific jobs from GitHub REST, not only the connector summary. Record `run_attempt`, job ID, runner fields, start/end times, and check-run `annotations_count`.
2. Perform at most one controlled retry. If the new attempt repeats the same fingerprint, stop retries; they do not test the source code and produce no code-level diagnostic.
3. Check GitHub Status for the exact date, but do not infer that a green status page rules out a repository/account-specific runner-dispatch issue.
4. Do not attribute the failure to billing, secrets, workflow YAML, source code, or a vulnerability without evidence. Do not label tests or security scans PASS/FAIL as code results when no step ran.
5. Escalation evidence should include repository, workflow/run ID, attempt, job ID, `runner_id`, timestamps, log `BlobNotFound`, and check-run annotation counts. The root cause remains `UNDIAGNOSED` until a runner-side reason or actual step output is available.

Current verified example (2026-10-27): LudoMada run `40484112539`, attempt 2, job `122125610049`; `runner_id=0`, blank runner name, 3 seconds, zero steps; Security Audit run `40484113100` has four failed GitHub-hosted jobs with the same pre-step symptom. No public Actions incident was reported that day. No production or secret changes were made.
