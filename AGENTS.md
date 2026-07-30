# AI Coding Mate Agent Guide

## Product contract

AI Coding Mate is a thin control layer around Firstmate and Herdr for users who want to work at the architecture level.

- Firstmate is the only primary Architect and liaison.
- Do not fork, patch, or write generated state into the pinned Firstmate clone.
- Keep runtime state, generated Captain preferences, run records, and capsules outside the upstream clone.
- Prefer deterministic recipes with explicit risk, model-role, fallback, review, and stop rules.
- The primary report must be concise and decision-ready. Put evidence, uncertainty, lineage, and technical detail in an expandable second layer.
- Preserve recall before narrowing research results. Keep confirmed facts, candidates, inferences, and unknowns separate.
- External, destructive, credential, privacy, and meaningful-cost actions fail closed and require explicit confirmation.

## Implementation workflow

1. Read the assigned GitHub issue and its blockers.
2. Work only when every blocker is complete.
3. Use TDD at stable seams where practical.
4. Run focused tests and typechecking while developing.
5. Run the full test suite before handoff.
6. Drive the changed behavior through its real CLI, Herdr, Firstmate, or Codex surface.
7. Review the final diff and commit the completed slice.

Tests and exit codes are supporting evidence, not the user-facing completion gate.

## Runtime safety

- Never stop, restart, rename, or clean up the user's ambient Herdr session for a test.
- Use isolated config/state directories and exact resource ids for lifecycle tests.
- Treat a missing or ambiguous pane, task, worker, thread, run record, or lineage binding as unknown; do not infer ownership from labels.
- Keep the pinned Firstmate checkout pristine and verify its commit plus `git status` after integration tests.
- Herdr plugins run unsandboxed as the user. Installation and documentation must disclose that trust boundary.

## Code and documentation

- Use Bun when the repository does not already establish another runtime.
- Keep adapters limited to runtime launch, capsule transport, result read-back, capability reporting, and normalization.
- Provider-specific model ids belong in model policy, not workflow recipes.
- User-facing documentation and output use Traditional Chinese. Code identifiers and upstream API names may remain English.
- Preserve unrelated user changes. Never weaken a failing test or claim an unobserved runtime result.

## Issue tracker

GitHub Issues in `lunhsiangyuan/aicoding-mate` are the delivery source of truth. See `docs/agents/issue-tracker.md`.
