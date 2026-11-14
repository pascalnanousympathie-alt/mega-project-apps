# ACEP Mega Project Agent System

Four local role agents are coordinated by a persistent worker and supervisor. Model execution is routed through Bankr LLM Gateway; credentials remain outside the repository.


## Mandatory project-scope preflight

- Read [`PROJECT-BOUNDARIES.md`](PROJECT-BOUNDARIES.md) and the target repository's `AGENTS.md`/`README.md` before assigning work or changing build/deployment instructions. This is mandatory for each new project and each cross-project task.
- Respect the requested product/output format. Do not infer APK work from Android files or say a website is done just because an APK builds. Nanou Browser and Nanoumada are web products; Nanou Browser's web/MCP delivery is the current scope, and Nanoumada is a separate AI coding workspace.
- Make repo-specific changes in an isolated branch/PR. Don't confuse repositories, credential stores, hosted projects, runner labels or local uncommitted work.
- Report the exact repo/branch/SHA, what tests actually ran, external side effects, and remaining proof. A live MCP connection requires plan eligibility plus verified HTTPS endpoint, `initialize`, `tools/list` and harmless tool call.

## Role routing
- Project Manager → `qwen3.8-flash` for scope, milestones, dependencies and blockers.
- Senior Developer → `deepseek-v4.1-flash` for architecture, implementation, debugging, tests and correctness.
- DevOps → `qwen3.8-flash` for runtime, builds, CI/CD, reliability and deployment evidence.
- Security Auditor → `deepseek-v4-pro` for security, abuse cases, secret handling and high-risk review.

## Phase routing
- P04–P14 → `deepseek-v4.1-flash`
- P15–P19, P21, P23–P25, P29–P30 → `qwen3.8-flash`
- P20, P22, P26–P27 → `deepseek-v4-pro`
- P28 → Gemini checkpoint-only; no Gemini call is allowed before its credential/mode is explicitly enabled.

## Gates
START → STATE → CHECKPOINT → EXECUTE → TEST → SECURITY → EVIDENCE → REVIEW → PASS/BLOCKED.
A model response never creates PASS by itself. Only real repository changes plus machine-verifiable tests/security evidence may create a phase completion marker.

## Protected scope
`~/LudoMada` and `.ludomada-agent` are protected from this experimental ACEP worker.

## Resumability
The worker uses runtime state, phase markers, lock files and a persistent tmux session. A failed phase remains BLOCKED/WAITING and retries without promoting release state.
