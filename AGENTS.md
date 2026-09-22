# ACEP Mega Project Agent System

Four local role agents are coordinated by a persistent worker and supervisor. Model execution is routed through Bankr LLM Gateway; credentials remain outside the repository.

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
