# SYMPHONY Coding Team V1 architecture

## Ownership and SSOT

The ASUS runtime owns Projects, Tasks, Agents, Roles, Sessions, worker processes, Discord mappings, locks, delivery records, and recovery state in SQLite WAL mode. Main Hermes memory is context only, never project state.

Context priority is fixed:

1. Filesystem and Git
2. Project SSOT documents
3. Persistent Task state
4. Explicit Discord context
5. Role-filtered memory

## Runtime flow

```text
Discord command / Main TASK_JSON
  -> persist Task(QUEUED)
  -> capability + availability assignment
  -> persist DISPATCHED + emit TASK mention
  -> acquire workspace/file locks + Git inspection
  -> emit ACK + persist CLAIMED
  -> resolve bounded context package
  -> common AgentAdapter -> installed CLI process
  -> persist worker PID/session/log/evidence
  -> emit RESULT to next_owner
  -> PASS or FAIL
```

`AgentAdapter` exposes availability, auth check, start/resume/cancel/status/result/health and logical model get/set. Unsupported capabilities must report unsupported rather than being emulated.

## CLI contracts on this ASUS

- Codex: `codex exec --json`, `codex exec resume <session>`, `--model`, ChatGPT CLI login.
- Claude Code: `claude --print --output-format stream-json`, `--resume`, `--model`, existing claude.ai login.
- OpenCode: `opencode run --format json`, `--session`, `--model`, configured provider credentials.
- Command Code: `commandcode --print --output-format json`, `--session`, `--model`, Command Code login.

The runtime does not read or serialize credential files. It runs the executable in the same ASUS user environment.

## Discord coexistence

Existing guild categories and channels are not deleted or renamed. With Manage Channels permission, the runtime idempotently adds `CODING TEAM` with `coding-control`, `coding-status`, and `coding-alerts`. It discovers all guild channels at startup, consumes channel/thread gateway events, and reconciles periodically. Channels beneath `PROJECTS` become project mappings and their threads become task-context mappings.

One optional Orchestrator Bot can lead control traffic. If it is not configured, the runtime uses the existing ASUS Hermes Discord identity through the local Hermes CLI transport and records `FALLBACK_CONTROL_IDENTITY`. A coding worker is never used as the author of its own TASK. Each configured coding bot sends ACK/RESULT under its own identity.

## Discord-native control plane

Phase A accepts a bot-authored message only when the author is in the persistent trusted-bot registry, the receiving client is explicitly mentioned by Discord ID, the author is not the receiving client, the envelope event and role are allowed, the Task exists, the discussion round is within the configured limit, and neither the Discord message ID nor its logical event key has already been processed. Human command handling remains on the leader gateway path.

Native envelopes support `TASK`, `ACK`, `RESULT`, `REVIEW`, `QA_RESULT`, `VERDICT`, `HANDOFF`, `REVISION_REQUEST`, and `REVISION_RESULT`. Inbound claims and processing outcomes survive restart in SQLite. `ACK`, `RESULT`, `QA_RESULT`, and PASS verdicts do not trigger automatic protocol replies.

Logical recipients (`MAIN`, `ASUS`, `CODEX`, `CLAUDE`, `OPENCODE`, `COMMANDCODE`) resolve through registry/config data to concrete Discord Bot IDs. Unknown recipients are persisted as `DELIVERY_BLOCKED_RECIPIENT_UNKNOWN`; the runtime does not report a successful delivery.

## Dynamic Task Workrooms

Every non-control Project Task is bound to one public Discord Thread under its discovered Project channel. Project categories are normalized so emoji-prefixed and case variants of `PROJECTS` are discovered without renaming the Guild. Resolution prefers an explicit project mapping, then exact normalized project ID/name/channel metadata; ambiguity is blocked rather than fuzzy-matched.

The persistent `workrooms` relation is keyed by Task ID and stores the Thread, parent channel, bootstrap message, lifecycle state, synchronization timestamp, and diagnostic reason. Protocol events use the persisted Thread rather than `coding-control`. Repeated dispatch, Gateway replay, and Runtime restart reuse the relation. A missing Thread moves an eligible active Task to `WAITING_MAIN` and is never silently replaced.

Workrooms remain active through review, revision, failure retry, blockers, and human gates. Only a final Task `PASS` or `CANCELLED` archives the Thread. Archive failure is recorded as an operational issue without rewriting the Task result.

## Sequential Role and Agent routing

Team-enabled Tasks are classified into a deterministic Task Type and ordered Role plan. Explicit `required_roles` takes precedence over the Task Type policy. The backward-compatible `tasks.role` and `assigned_agent` fields remain, while `task_teams`, `task_roles`, and `routing_decisions` are the persistent source for multi-Role execution.

Agent selection filters health, availability, Role capability coverage, Discord connectivity, and workspace conflicts before applying an explainable score for project/session context and diversity. Manual Agent overrides pass through the same safety filters. Reviewer selection excludes the implementation Agent whenever another eligible Reviewer exists; unavoidable same-Agent review is recorded as `INDEPENDENT_REVIEW_UNAVAILABLE`.

The scheduler runs one Role at a time in the existing Workroom. Execution Roles produce `RESULT`, Reviewers produce `REVIEW`, and QA produces `QA_RESULT`. Revision rewinds the same implementation and Reviewer Role rows without creating another Task or Thread. A Role result is only a candidate: the Task becomes completion-eligible and transitions to final `PASS` only after every required Role is `PASS`, after which the Workroom archives.

## Recovery contract

Reconciliation order is Task state, worker PID, Git/artifacts, then Discord delivery. A dead worker attached to `CLAIMED`/`RUNNING` is moved to `WAITING_MAIN`, not replayed. A Discord send left in `attempting` becomes `ambiguous`, avoiding duplicate blind delivery. Terminal tasks never re-enter the queue automatically.

## Expansion seam

HermesAdapter and future office departments can implement the same adapter/role/task contracts. Idea candidates already have a persistence table but automatic classification is intentionally outside V1.
