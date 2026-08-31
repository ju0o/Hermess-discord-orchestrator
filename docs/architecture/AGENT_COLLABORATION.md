# Agent Discussion and Dynamic Experts

The Runtime database is the source of truth. Discord only displays collaboration events in the Task Workroom.

## Discussion boundary

- Allowed events are `QUESTION`, `ANSWER`, `PROPOSAL`, `OBJECTION`, `CLARIFICATION`, and `CONSENSUS`.
- Both agents must be persistent members of the same Task Team, the message must contain a real recipient mention, and the Discord Thread must equal the Task Workroom.
- Each normalized topic has an independent three-turn limit. Exact repeated content is fingerprinted and rejected even when the Discord message ID changes.
- `CONSENSUS` closes a topic but does not complete the Task. A fourth turn records `AGENT_DISAGREEMENT` and hands a concise evidence packet to ASUS.
- ACK, CONSENSUS, final PASS, and EXPERT_RESULT never create automatic reply chains.

## Dynamic Expert gate

`EXPERT_REQUEST` is accepted only for an active Task and an existing Team member. The Runtime first checks existing Team Roles and capabilities. If the expertise already exists, no Expert is added.

Otherwise the Phase C Agent Router applies health, availability, capability, Discord connectivity, and workspace-conflict checks. The Phase E Model Router then selects an execution-verified model. One `(Task, Role)` Expert membership can exist, preventing duplicate invites.

Expert membership and request state are persistent. The scoped context contains the Task Brief, request reason/evidence, bounded file scope, recent relevant discussion, decisions, and existing project context. An Expert does not become Task owner and the original `current_role_sequence` is preserved.

## Authority and execution

Coding Agents may discuss bounded implementation, review, debugging, testing, and file-level design. Production deployment, credentials, paid resources, destructive data operations, history rewrite, and security-boundary changes transition to `HUMAN_GATE` where the Task state permits it.

The scheduler remains sequential. Expert execution refuses to start while another worker process is active for the Task, retains workspace/file locks, and returns to the original Role pipeline after `EXPERT_RESULT`.

No discussion or Expert conclusion is automatically written to personal memory. A future `DECISION_CANDIDATE` policy may promote approved technical decisions.
