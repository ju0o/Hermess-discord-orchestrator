# Symphony V1.2 Known Baseline Risks

Recorded for the Symphony Coding Team V1 baseline before Phase A. These are accepted baseline limitations, not changes implemented by Packet A0.

## Discord control plane

- There is no independent Orchestrator Discord identity.
- MAIN recipient mapping is incomplete.
- The Codex Bot is the gateway leader and fallback Orchestrator identity.
- A Codex TASK can therefore be self-authored and self-mentioned.
- Coding Bot messages are not accepted as inbound work, so bot-to-bot processing is unavailable.

## Work coordination

- Dynamic Workroom support is partial; existing channels and active threads can be discovered, but Task thread creation, reuse, archival, and complete recovery are absent.
- Agent Discussion is missing.
- Dynamic Expert Invite and persistent task-team membership are missing.

## Models and performance

- Model selection, persistence, and actual-model capture are partial.
- Performance and quality metrics are partial and not normalized across agents.

## Recovery

- Session restoration and orphan process/lock reconciliation are partial.
- Ambiguous Discord delivery reconciliation is partial.

These risks are intentionally preserved in the V1 baseline and are candidates for subsequent V1.2 packets. Packet A0 does not fix them.
