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

## v0.2 draft tickets

這三張是本地已核准規格，尚未自動發布到 GitHub Issues。

```text
V2-01 Firstmate Workflow Authority
  └──> V2-02 Canonical Run Registry
         └──> V2-03 Authority migration gate
```

### V2-01 Firstmate Workflow Authority

- Owner：Control Plane
- Outcome：Firstmate 成為 recipe、角色、model、fallback、Judge 與 Report Composer 的唯一 decision writer。
- Acceptance：Adapter 只執行 immutable assignment；availability 改變必須產生新 decision version。

### V2-02 Canonical Run Registry

- Owner：Runtime
- Blocked by：V2-01
- Outcome：stable idempotency、canonical run、attempt、outbox、lease、reconciliation 與 append-only lineage。
- Acceptance：重複 intent coalesce；dispatch crash window 不重派；成功 canonical run 不被失敗 attempt 遮蔽。

### V2-03 Authority migration gate

- Owner：Integration
- Blocked by：V2-01、V2-02
- Outcome：所有 v0.1 workflow 接到同一 decision/run authority。
- Acceptance：以先前重複 Standard dispatch 作實機回歸，通過前 authority 欄位保持 deferred。
