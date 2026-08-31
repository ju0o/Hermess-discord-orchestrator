# Persistent Model Catalog

The SQLite model catalog is the Runtime source of truth. This document is an operational view, not an input parsed by the router. Phase D does not perform automatic model routing, tier assignment, or escalation.

## Verification levels

| Level | Meaning |
|---|---|
| `DISCOVERED` | Present in a current local cache or metadata file only. |
| `CLI_REPORTED` | Listed or documented by the installed CLI itself. |
| `CONFIGURED` | Selected in the current ASUS user configuration. |
| `EXECUTION_VERIFIED` | A minimal safe invocation succeeded; the evidence source records whether the effective model came from an event, session export, or an accepted explicit override. |
| `UNAVAILABLE` | Rejected or no longer usable; it is excluded from override restore. |

## ASUS verification snapshot

Verified on 2026-08-10. Candidate counts are stored in `model_catalog` and can change when `LocalModelDiscovery.refresh()` is run after a CLI update.

| Agent | Provider | Model or alias | Verification | Override method | Observed effective model |
|---|---|---|---|---|---|
| Codex | `openai-chatgpt` | `gpt-5.6-sol` | `EXECUTION_VERIFIED` | `--model gpt-5.6-sol` | `gpt-5.6-sol` (accepted explicit override; Codex JSON events do not emit the model field) |
| Claude Code | `claude.ai` | `sonnet` | `EXECUTION_VERIFIED` | `--model sonnet` | `claude-sonnet-5` |
| OpenCode | `opencode-go` | `deepseek-v4-flash` | `EXECUTION_VERIFIED` | `--model opencode-go/deepseek-v4-flash` | `deepseek-v4-flash` from session export |
| Command Code | `command-code` | `poolside/laguna-s-2.1-free` | `EXECUTION_VERIFIED` | `--model poolside/laguna-s-2.1-free` | `poolside/laguna-s-2.1-free` from model event |

Claude CLI aliases currently reported by the installed help are `fable`, `opus`, and `sonnet`. OpenCode reports provider-qualified IDs and supports `--variant`; the catalog does not invent or assign variants. Command Code reports its complete model list through `--list-models`. Codex candidates from `models_cache.json` remain `DISCOVERED` until stronger evidence promotes them.

## Persistence and commands

`agent_model_preferences` stores explicit Runtime overrides. Startup restores only an available catalog entry; a stale or unavailable entry becomes `MODEL_REVALIDATION_REQUIRED` and is not forced into a CLI invocation. The external CLI config and login material are never modified.

- `!agent model CODEX` shows requested, observed effective, provider, and verification.
- `!agent models CODEX` lists current available catalog entries.
- `!agent model CODEX <model>` validates and persists an override.

Sessions keep `requested_model`, `effective_model`, `provider`, and `model_verification_source` separately. `UNKNOWN` is used when a CLI does not expose effective-model evidence; the Runtime does not guess.
