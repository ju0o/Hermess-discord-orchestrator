# Symphony Performance Ledger

## Purpose

The Performance Ledger is an observability layer. It records what a Task, Role, Agent, and verified Model actually did and links derived metrics to durable evidence. It does not score workers and it does not alter Agent or Model routing.

Runtime SQLite remains the source of truth. The ledger is an idempotent projection of existing Task, Role, Protocol, Model, Discussion, Expert, and Process state.

## Records

- `performance_task_records`: one current snapshot per Task, including lifecycle, duration, attempts, revisions, discussions, expert invitations, human gates, and model escalations.
- `performance_role_records`: one current snapshot per Task Role sequence, including Agent, requested/effective Model, Tier, outcome, duration, revision count, and evidence sources.
- `performance_events`: structured Review, QA, Revision, Discussion, Expert, and Model Escalation metrics. `logical_key` prevents restart/backfill duplicates.

Aggregates are queried from these records; there is no mutable score table.

## Evidence Sources

- `TASK_STATE`: persistent Task, Role, Team, and Expert state.
- `DISCORD_PROTOCOL`: typed protocol event and its durable event reference.
- `MODEL_EVENT`: persistent model routing or escalation record.
- `CLI_ARTIFACT`, `TEST_RESULT`, `PROCESS_REGISTRY`, and `MANUAL_VERDICT` are reserved sources for evidence that is actually available.

The ledger stores counts, categories, timestamps, and references. It does not duplicate prompts, discussion bodies, personal memory, credentials, or bot tokens. Free-form routing reasons are redacted before storage.

## Data Classes

- `REAL_PROJECT`: production project work. This is the default summary filter.
- `CANARY`: `SYM-E2E-*`, `SYM-WORKROOM-*`, `SYM-TEAM-*`, `SYM-DISCUSS-*`, `SYM-EXPERT-*`, and `SYM-PERF-*` validation Tasks.
- `TEST`: test/fixture Tasks.

Known historical `SYM-*` validation Tasks are classified conservatively during backfill. Explicit `data_class` metadata takes priority. If no real project evidence exists, commands return `NO_REAL_PROJECT_DATA`; Canary success is never presented as real-project performance.

## Failure Classification

The shared observability taxonomy is:

`PROJECT`, `AGENT_CAPABILITY`, `MODEL_CAPABILITY`, `CONTEXT`, `WORKSPACE_CONFLICT`, `ENVIRONMENT`, `TOOL`, `AUTH`, `NETWORK`, `TEST`, `BUILD`, `REVIEW`, `QA`, `HUMAN_GATE`, and `UNKNOWN`.

Context subcategories are recorded only when explicit evidence exists: `MISSING_REQUIRED_CONTEXT`, `STALE_CONTEXT`, `WRONG_PROJECT_CONTEXT`, `INSUFFICIENT_FILE_SCOPE`, and `CONTEXT_TOO_LARGE`.

## Usage and Cost Semantics

Input/output/cache tokens and reported cost remain NULL when the CLI or provider does not provide reliable evidence. Codex and Claude subscription execution is marked separately from provider-based execution. Unknown usage is never estimated, and subscription and provider cost are not compared as if they were one USD metric.

## Confidence

- fewer than 5 Role executions: `INSUFFICIENT_DATA`
- 5 through 19: `EARLY_SIGNAL`
- 20 or more: `OBSERVED`

Thresholds are configurable with `PERFORMANCE_EARLY_SIGNAL_MIN` and `PERFORMANCE_OBSERVED_MIN`. Confidence labels describe sample volume, not quality scores.

## Discord Commands

- `!performance agents`
- `!performance CODEX`
- `!performance role REVIEWER`
- `!performance models CODEX`
- `!performance project <PROJECT_ID>`

Commands default to `REAL_PROJECT`. Append `canary`, `test`, or `all` to change the filter. Output is concise and always states that performance learning is disabled.

## Failure Isolation and Recovery

Collection uses lifecycle/protocol observers and catches write failures. `OBSERVABILITY_WRITE_FAILED` is stored in runtime diagnostics, while the coding Task keeps its own result. Startup backfill reconciles projections from durable source tables. Stable Task/Role/event logical keys make repeated backfill and restart recovery idempotent.

## No Learning Yet

`PerformanceScorer.enabled` is false. Phase C Agent routing and Phase E Model routing do not read Performance Ledger data. Future activation requires real-project sample volume, an explicit approval gate, evidence-quality review, Canary exclusion, and regression tests proving safety and explainability.
