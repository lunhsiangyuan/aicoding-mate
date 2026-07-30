# v0.1 實作計畫

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
- v0.1 功能、非目標與驗收情境一致。

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

## Phase 5：Report、QA 與公開 v0.1

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

## v0.1 後候選

- Cursor／Gemini production adapter。
- 視覺化 workflow editor。
- 自訂 recipe marketplace。
- 多使用者、團隊政策與預算治理。
- 原生文件／簡報 annotation 整合。

這些項目不阻擋 v0.1。
