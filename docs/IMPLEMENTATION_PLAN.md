# v0.2 實作計畫

這份計畫以使用者可觀察的行為為交付單位，不以「程式碼存在」當作完成。

## Phase 0：規格與邊界

交付：

- 核准的產品規格。
- 控制層與執行層架構。
- Captain、Decision、Model、Workflow、Adapter 設定範例。
- Firstmate／Herdr 固定版本與非 fork 原則。

完成證據：

- 所有 YAML 可解析。
- README、spec、架構與設定互相連結。
- v0.2 功能、非目標與驗收情境一致。

## Phase 1：Control Contracts

交付：

- 載入與驗證結構化設定。
- Captain Preference renderer。
- Decision Registry 與 append-only lineage。
- Intent、Context、Review、Report capsule schemas。
- 風險分類與確認 gate。

完成情境：

- 一個已回答偏好在新 task 中不會被重問。
- 可逆動作自動通過；外部或不可逆動作在執行前停下並複誦。
- 結構化偏好可穩定產生 Firstmate 的 `captain.md`。

## Phase 2：Firstmate on Herdr

交付：

- 固定版 Firstmate bootstrap。
- Herdr backend／plugin 啟動與健康檢查。
- Firstmate crew dispatch adapter。
- task、worker、worktree 與結果的共同 run record。

完成情境：

- 從 Architect 輸入一個小型任務。
- Firstmate 經 Herdr 派出 worker。
- worker 在隔離工作區完成。
- 結果與驗證證據回到同一主 task。

## Phase 3：Workflow 與模型路由

交付：

- `quick`、`standard`、`adversarial`、`research` 狀態機。
- role-based model aliases 與 fallback。
- Codex／Claude cross-family review。
- bounded adversarial debate 與 independent Judge。
- Coverage Review。

完成情境：

- 同類型與同風險任務選到相同 recipe。
- author 和 reviewer 優先使用不同模型家族。
- 高風險流程在 Judge 後收斂，不超過兩輪。
- Research 報告能指出漏答，而不只指出錯誤。

## Phase 4：Context 與原生 Review UX

交付：

- Herdr 明確選取觸發的 Context Lens。
- popup／new-tab Context Branch。
- Context Capsule 在 Branch 與原主對話之間往返。
- `Open in Codex Review` handoff。
- Codex Review Capsule 回傳。

完成情境：

- 選取文字後先得到白話簡介。
- 深入研究不污染主對話。
- 「帶回計畫」能被主對話判斷成新增或修改，並在執行前複誦。
- Codex 原生批註回到正確來源 task。

## Phase 5：Report、QA 與公開 v0.2

交付：

- Recall-first 雙層 Report Package。
- Evidence Layer 與 Coverage mapping。
- 設定 UI 與 YAML 等價 round-trip。
- 安裝／升級／rollback 流程。
- 公開範例與操作文件。

完成情境：

- 第一層報告不依賴技術附錄也能做決策。
- 候選資訊不因尚未完全證實而消失。
- 更換 research adapter 不改變 workflow 與權限語意。
- 所有六項 [驗收情境](SPEC.md#7-驗收情境) 取得 runtime read-back evidence。

## 實作順序原則

1. 先做權限與資料契約，再接模型。
2. 先打通一條 Codex／Claude end-to-end，再增加 provider。
3. 先固定 workflow 與停止條件，再提高動態性。
4. 先完成文字化 Context／Review Capsule，再加入 UI handoff。
5. 每個 phase 都要能被真實使用，不能只以測試綠燈宣告完成。

## v0.2 後候選

- Cursor／Gemini production adapter。
- 視覺化 workflow editor。
- 自訂 recipe marketplace。
- 多使用者、團隊政策與預算治理。
- 原生文件／簡報 annotation 整合。

這些項目不阻擋 v0.2。

## v0.2 核心交付

### V2-01 Firstmate Workflow Authority

Status：完成。

交付：

- versioned decision envelope。
- Firstmate authority store、Ed25519 signing identity 與 strict decision receipt read-back。
- signed execution policy，固定 Adapter、named-skill fallback 與 debugging gate。
- Firstmate-only workflow mutation API。
- Author、Reviewer、Challenger、Judge、Report Composer 的完整 assignments。
- Adapter contract 移除 model selection、fallback 與 workflow retry。
- availability 改變時的 re-decision 流程。

完成情境：

- 對 Adapter 注入 quota failure，只會得到 observation，不會發生私下 fallback。
- 每個 worker 與 report 都能追溯到同一 decision version。
- 修改 Adapter 不會改變 recipe、barrier 或停止條件。
- decision receipt 驗證失敗時，所有 Adapter call counter 維持零。

### V2-02 Canonical Run Registry

Status：完成。

Blocked by：V2-01 的 decision envelope identity。

交付：

- stable intent fingerprint 與 idempotency key。
- canonical run／attempt 分離。
- durable intent + dispatch receipt。
- lease／compare-and-set single-writer gate。
- downstream receipt read-back 與 `unknown_outcome` reconciliation。
- append-only task、worker、artifact、review、report lineage。

完成情境：

- 同一 intent 的並行或連續重送只建立一個 canonical run。
- dispatch crash window 不會產生第二個外部 task。
- 成功 run 不會被較新的失敗 attempt 遮蔽。
- Run Registry read-back 與 matching Herdr pane 顯示同一 canonical result。

### V2-03 Authority migration gate

Status：authority core implemented；Standard real-surface gate 完成。完整 release evidence 尚缺 Adversarial／Research 真實 Herdr 執行與 Native completed capsule。

Depends on：V2-01、V2-02（已實作）。

交付：

- Standard、Adversarial、Research、Codex Review 使用同一 registry contract。
- Quick 接收上層 idempotency key；Context Branch 維持一次性 lineage handoff，不取得 workflow authority。
- 舊 v0.1 records 保持唯讀，不回填或偽造 v0.2 authority。
- duplicate Standard dispatch 的回歸測試與實機證據。
- 新 v0.2 record 只在 decision／registry／artifact strict read-back 通過後標示 verified。
- 舊的未簽章 decision record 保持不可驗證，不回填 `firstmate_verified`。
- 證據封存在 [QA_EVIDENCE.md](QA_EVIDENCE.md)：Standard duplicate coalesce、原 decision reconciliation、Herdr worker/pane read-back、Codex task handoff 與 interrupted fail-closed；未完成的 real-surface lanes 明確列為未證明。
