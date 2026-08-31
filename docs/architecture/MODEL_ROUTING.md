# Evidence-Based Model Routing

The Runtime database is the source of truth. This document explains the Phase E policy; it is not parsed as configuration.

## Complexity

| Level | Meaning | Initial logical tier |
|---|---|---|
| T0 | Deterministic scripts, formatting, metadata extraction | CHEAP |
| T1 | Small isolated work with low ambiguity | CHEAP |
| T2 | Normal feature, bug, or refactor reasoning | STANDARD |
| T3 | Concurrency, migration, state flow, multiple plausible causes, or cross-subsystem reasoning | STANDARD |
| T4 | Architecture-level ambiguity, major tradeoffs, or repeated reasoning failures | STRONG |

File count, line count, duration, and task length do not independently raise complexity. An explicit Main/ASUS complexity override is persisted with source `MANUAL`.

## Verified tier mapping

Only `EXECUTION_VERIFIED` catalog records can be enabled. Unlisted cells are intentionally unavailable, not inferred.

| Agent | CHEAP | STANDARD | STRONG | FRONTIER |
|---|---|---|---|---|
| Codex | gpt-5.6-luna | gpt-5.6-terra | gpt-5.4 | gpt-5.6-sol |
| Claude Code | — | sonnet → claude-sonnet-5 | — | — |
| OpenCode | — | opencode-go/deepseek-v4-flash | — | — |
| Command Code | poolside/laguna-s-2.1-free | deepseek/deepseek-v4-flash | — | — |

Codex descriptions come from the installed CLI model cache. Command Code tier evidence comes from its installed `--list-models` output. New calibration candidates pass the same four small read-only prompts before mapping.

## Fallback

- CHEAP may fall upward to STANDARD, STRONG, then FRONTIER.
- STANDARD may fall upward to STRONG, then FRONTIER.
- STRONG may fall upward to FRONTIER.
- Downgrades are never silent. T3 cannot run on CHEAP merely because STANDARD is missing, and T4 cannot run on STANDARD when STRONG is missing.
- No suitable verified mapping results in `MODEL_ROUTING_BLOCKED`.

Override priority is explicit model, explicit tier, persisted escalation, complexity policy. Explicit models still require current execution verification and Agent/provider compatibility.

## Escalation

The first model-capability failure gets one same-model retry. The same category recurring for the same Task, Role, and model may move to the next verified Tier. Every retry and escalation is persisted with category, reason, attempt, and evidence.

No model escalation occurs for authentication, provider/network, process/tool, or other environment failures. Syntax, lint, formatting, and obvious project defects receive at most a same-model correction and never trigger an automatic Tier increase. Agent-capability evidence is recorded as an Agent Router candidate rather than a model escalation.

Developer, Reviewer, and QA decisions are independent. Role-specific mappings can override the Agent-wide `*` mapping without creating an Agent=Role binding.

Phase E does not use historical success rates, monetary budgets, performance learning, or parallel execution.
