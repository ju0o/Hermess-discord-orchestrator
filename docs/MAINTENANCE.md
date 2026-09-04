# HERMESS maintenance mode

## Current status

HERMESS Discord Orchestrator is an early Public Preview. The normal Node/npm
Runtime path has been validated on Windows 10/11 and Ubuntu Native. Other
Linux distributions are not explicitly certified.

## Current supported scope

- Local Runtime, Discord coordination, and SQLite Task state.
- Configurable Worker CLI surfaces and deterministic Task lifecycle handling.
- Implementation, Review, and QA contracts where configured.
- Bounded recovery and locally inspectable evidence behavior.
- Windows and Ubuntu-native normal Runtime execution.

HERMESS does not claim autonomous production readiness.

## Maintenance Mode

Active feature development is closed for the current project cycle. Future
changes should normally be limited to:

1. Critical correctness or security bugs.
2. Meaningful external Issues.
3. Meaningful external PRs.
4. A blocker discovered during real HERMESS dogfooding.
5. Compatibility maintenance for already-supported surfaces.

Normal speculative feature expansion is not active work.

## Explicit non-goals for this phase

- A separate Ubuntu Edition.
- GUI installer, apt package, Docker packaging, hosted/cloud HERMESS, or an
  autonomous production-operation claim.
- Broad new provider integrations, a large Supervisor redesign, or speculative
  multi-agent features not required by dogfooding.

These are possible future ideas, not current commitments.

## Reporting

Keep the existing public Issue, PR, and security-reporting guidance in the
[README](../README.md#security-and-reporting). Do not include private Company
OS material, credentials, or private operational evidence in public reports.
