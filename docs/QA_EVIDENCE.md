# AI Coding Mate v0.2 QA Evidence

本文件保存 2026-07-31 在 macOS、Herdr 與 Codex Desktop 的實機 gate。它區分「已證明」「部分成功」「未證明」，不以測試綠燈或 task 曾啟動取代 runtime read-back。

## Release snapshot

- Runtime code commit：`f757016`（包含 `d578cab` 的 decision reconciliation／registry recovery、`a32e7d3` 的單一 CLI trust anchor／Quick historical-unverified 邊界，並要求所有 public read-back caller 顯式傳入 authority root）。
- Herdr：client/server `0.7.3`、protocol `16`、`compatible: true`。
- Trust-boundary targeted gate：11 pass、0 fail、41 assertions。
- Full gate：167 pass、0 fail、793 assertions；`bun run typecheck` 通過。
- CLI gate：`--help` exit 0、缺少 Standard task exit 2、doctor 8/8 ready、Standard `read-run` exit 0、alternate `FM_HOME` exit 1、Quick historical record exit 1。

## Evidence coverage

- **真實 Herdr surface 已證明**：Standard 建立真 worker、報告回到來源 pane、durable record read-back、相同 intent duplicate coalesce。
- **真實 Codex handoff 部分證明**：Native Review 建立 detached task 並開啟同一 Codex Desktop thread；原受管 turn 被中斷，因此 completed capsule 未證明。
- **受控 runtime tests 已證明**：Adversarial／Research 的 Firstmate decision、跨模型角色、兩輪上限、coverage、registry、receipt 與 fail-closed 行為。
- **尚未以真實 Herdr surface 證明**：Adversarial／Research 完整外部模型執行，以及 Native completed Review Capsule。這些不得由綠色 tests 取代。

## Standard：真實派工與 duplicate coalesce

來源與受管執行：

- Herdr source pane：`w1P:p8`
- Firstmate worker pane：`w1Q:p9`
- Codex worker session：`019fb6aa-51ca-7ae3-95a2-bab61e6c4792`
- Canonical run：`run-390f9c8d1fa1cc4b7466db13fa0cd6030375ecb0b87dc3465b4856c2f1821bf4`
- Workflow decision：`wfd_707703dd4784c2f30a0f743bdfbce71e`
- Durable record：`state/aicoding-mate/standard-runs/standard-390f9c8d1fa1cc4b7466db13fa0cd6030375ecb0b87dc3465b4856c2f1821bf4.json`

實機觀察：

1. 第一次 Standard run 由 Firstmate 在 Herdr 建立真 worker，報告回到 `w1P:p8`。
2. durable record 的四個 claims 均為 `true`：Firstmate author 完成、獨立 review 完成、report decision-ready、pane read-back 一致。
3. 完全相同的 Standard command 在 commit `d578cab` 後再次從 `w1P:p8` 執行，立即回傳同一 record 與同一報告。
4. `w1Q` 的 worker pane 仍止於 `p9`，沒有建立 `p10`；因此不是「看起來相同但其實又派一次」。

報告文字仍描述當時 reviewer 所看到的舊 HEAD 風險；duplicate coalesce 的目的正是讀回 immutable canonical result，而不是偷偷用新 HEAD 重算。

## Runtime Authority：crash-window recovery

受控 runtime tests 覆蓋全部目前 mutation event：

- `dispatch_recorded`
- `dispatch_accepted`
- `attempt_running`
- `attempt_completed`
- `attempt_failed`
- `attempt_unknown_outcome`
- `retry_attempt_created`

只有以下兩種情況自動修復：

1. event log 比 projection 正好多一筆，且 prefix、sequence、run ID、previous hash、event hash 與 payload schema 全部吻合；系統 deterministic replay 該 event。
2. 最後一行是不完整 JSON，且之前完整 events 與 projection 完全一致；系統只截除該半行。

多個 events ahead、完整但 schema 無效的 event、hash tamper 或中段損壞都維持 fail closed。

## Native Codex Review：task handoff 成功，completed capsule 未通過

### 同一 intent 的 crash reconciliation

既有選取內容再次從 `w1P:p9` 執行時：

- stable start artifact 數量沒有增加。
- 系統使用原 decision identity 與原 review thread 做 read-back，沒有再呼叫新的 `review/start`。
- 原受管 turn 曾被中斷，人工 follow-up 是另一個 turn，因此結果為 `review_not_completed`，沒有產生假 capsule。

### 新 intent 的真實 handoff

- Herdr action context：`HERDR_PLUGIN_CONTEXT_JSON`
- Canonical run：`run-3244ec1874b4d3d6d0b5cec687360e518a118b5be0a937c68f14fe7e3f90584c`
- Source thread：`019fb6cf-52bc-7271-90bd-e5b49db0064d`
- Review thread：`019fb6cf-579b-7d63-98c9-00e7b1caa982`
- Review turn：`019fb6cf-5e6e-7c53-8c3a-c44de1ec2dfd`

Herdr 確實啟動 `codex app-server --stdio`，stable start receipt 落盤，Codex Desktop connector 也以同一 review thread ID 回報 `navigated: true`。但 review turn 在工具檢查後被標成 `interrupted`，所以「task 建立／UI 開啟」通過，「completed turn／Review Capsule」未通過。

這個限制不由 Adapter 自動改成新模型、新 thread 或新 retry。若未來要自動續跑，必須由 Firstmate 明確增加 retry decision／receipt contract。

## 三個 debugging hypotheses

| 假設 | runtime 證據 | 判定 |
| --- | --- | --- |
| 相同 Standard intent 仍會建立第二個 worker | 相同 command 回到同一 canonical run；`w1Q` 無 `p10` | 否 |
| Native crash 後會因 availability 時間改變而重送 `review/start` | 原 stable start 被回讀；同一 intent 無新 start artifact，結果 fail closed | 否 |
| 任意 alternate signing root 可把 record 變成 verified | `a32e7d3` 正負 regression 與實機 CLI 均拒絕 alternate `FM_HOME`；只接受本次 invocation 的單一 root | 否 |

## 已知限制

- 本機 authority signature 不是遠端 model attestation；取得本機 private key 的攻擊者不在目前威脅模型內。
- Adapter receipt 記錄 Firstmate 下令的 model assignment，不宣稱 provider 回傳可驗證的實際 model identity。
- `ACM_IDEMPOTENCY_KEY` 會傳給可控下游；外部 provider 不一定提供 exactly-once。沒有權威 `not_found` 時保持 `unknown_outcome`。
- Native annotation export 尚未由公開 contract 證明；Review Capsule 是可攜 completion artifact。
- Herdr `pane run` 已通過；自動化 `pane send-keys Enter` 並未作為 release evidence。
- 相容性目標仍是 Herdr `v0.7.5`；本次實機是 `0.7.3`／protocol `16`。
- 本 snapshot 是 v0.2 authority core gate，不是所有入口的完整 production release；未完成項目以上方 Evidence coverage 為準。
