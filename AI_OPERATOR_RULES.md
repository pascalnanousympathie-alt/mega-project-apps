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
