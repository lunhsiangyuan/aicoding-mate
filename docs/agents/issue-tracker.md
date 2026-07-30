# Agent issue tracker

## Tracker

- Repository: `lunhsiangyuan/aicoding-mate`
- Tracker: GitHub Issues
- Agent-ready label: `ready-for-agent`
- Domain documentation mode: single repository context

## Blocking edges

Each issue contains a `Blocked by` section with GitHub issue references.

An issue is on the implementation frontier only when every referenced blocker is complete. The `ready-for-agent` label means the issue is sufficiently specified for an agent; it does not override blockers.

## Delivery policy

For each issue:

1. Confirm blockers from the live tracker.
2. Implement one demoable vertical slice.
3. Use TDD where the behavior has a stable seam.
4. Run focused tests, typechecking, then the full suite.
5. Exercise the actual user surface and retain runtime evidence.
6. Perform code review.
7. Commit the completed slice.
8. Close the issue only after its acceptance criteria are proven.

Do not close or modify an unrelated parent issue. Do not mark a ticket complete from code presence, tests alone, or an agent's self-report.

## v0.1 dependency graph

```text
#1 Herdr launch ──> #3 Firstmate Quick ──┬──> #4 Standard ──> #6 Adversarial/Research ──┐
                                        └──> #5 Context Branch ──> #7 Codex Review ──────┤
#2 Codex feasibility ─────────────────────────────────────────────> #7                  │
#4 + #5 + #6 + #7 ────────────────────────────────────────────────────────────────> #8
```
