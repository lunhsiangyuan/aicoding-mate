# AI Coding Mate v0.1 產品規格

- 狀態：Approved
- 日期：2026-07-30
- Repository：`lunhsiangyuan/aicoding-mate`
- 主要使用者：不想管理低階技術細節的 AI vibe coder

## 1. 產品目標

AI Coding Mate 要讓使用者以架構師的高度操作多模型 coding agents。

使用者負責：

- 說明想完成的結果。
- 決定優先順序與產品取捨。
- 批准成本、敏感資料、外部行動和不可逆操作。

系統負責：

- 將需求轉成可執行 workflow。
- 自動處理可逆的技術決策。
- 選擇模型、skills、adapters 與 review 強度。
- 保留重要候選資訊並標示成熟度。
- 回傳簡潔、完整、可以直接判斷的結果。

## 2. 成功體驗

一個成功的 v0.1 任務應該是：

1. 使用者用自然語言描述目標。
2. Architect 只詢問會改變產品結果的問題。
3. Workflow Engine 選擇固定 recipe。
4. Firstmate 經由 Herdr 派工給合適的模型與 skill。
5. Reviewer 檢查正確性，Coverage Reviewer 檢查遺漏。
6. 高風險任務才啟動有上限的對抗式討論。
7. 使用者先看到一頁內的主報告，需要時再展開證據與技術細節。
8. 後續選取任何內容，都能開啟同 context 的學習 Branch，並可帶回主對話形成任務。

## 3. 核心名詞

| 名詞 | 意義 |
| --- | --- |
| Architect | 唯一負責理解使用者、選 workflow、派工與整合結果的主要 agent。 |
| Captain Preference | 控制說話高度、報告形式與預設自主程度的偏好。 |
| Decision Policy | 強制規定哪些行動可自動進行、哪些必須確認。 |
| Workflow Recipe | 固定的階段與停止條件；實際任務、模型與 worker 數量可以動態決定。 |
| Context Branch | 從選取內容開啟的解釋／學習對話，保留原始 context，但不污染主對話。 |
| Context Capsule | 帶往 Branch 或其他 agent 的最小必要上下文。 |
| Review Capsule | 從 reviewer 帶回主對話的批註、修訂、證據與未解決問題。 |
| Decision Record | 對已回答偏好與重要產品決策的持久紀錄。 |

## 4. 功能需求

### FR-01 Architect-mode Firstmate

- Firstmate 是主要 Architect，不在它上方再增加另一個常駐 agent。
- Architect 以目標、架構、結果和影響與使用者溝通。
- 除非使用者要求，不直接輸出原始程式碼、log、內部路徑或冗長工具紀錄。
- 可逆的技術選擇由 Architect 自動決定並留下 Decision Record。

### FR-02 確定性的權限政策

預設自動執行：

- 唯讀檢查與搜尋。
- 任務範圍內的可逆本機修改。
- 測試、lint、typecheck 與產物驗證。
- 既有 workflow 允許的模型 fallback。

必須先複誦並等待確認：

- 發送、發布、部署、push、建立公開資源或改變權限。
- 付費或大量 API 使用。
- 敏感資料、credential、PHI 或個資處理。
- 刪除、覆寫或難以復原的操作。

### FR-03 Dynamic but Deterministic Workflow

- Architect 可依任務語意選擇 recipe。
- recipe 的階段、barrier、重試上限、review 與停止條件必須固定。
- 每個階段的 task、worker 數量與模型可以動態產生。
- 初始 recipes：
  - `quick`：小型、低風險、單一 owner。
  - `standard`：建置、跨模型 review、修復、驗證。
  - `adversarial`：reviewer、challenger、author response、獨立 judge。
  - `research`：高 recall 搜尋、去重、驗證、coverage review、報告。

### FR-04 角色式模型派工

- 設定以角色與能力描述模型，不把特定 model ID 寫死在 workflow。
- Architect 與 Judge 使用目前設定中最強且達到能力下限的模型。
- Builder 使用品質、速度與成本平衡的模型。
- Search／Explore 使用較快、較便宜的模型。
- 模型不可用、額度不足或過慢時自動 fallback。
- 若所有 fallback 都低於 Architect／Judge 的最低能力，才詢問使用者。

### FR-05 跨模型與對抗式 Review

- 作者與主要 reviewer 優先使用不同模型家族。
- worker 不得私下呼叫另一個 worker；所有派工與回傳都經過 Architect。
- 高風險任務使用：
  1. Author 產出。
  2. Cross-family Reviewer 找錯誤。
  3. Challenger 找反例、遺漏與錯誤前提。
  4. Author 回應。
  5. Independent Judge 裁決。
  6. Repair 與 final verification。
- 對抗討論預設一輪，最多兩輪，避免無止境辯論。
- Gemini 等低額度模型保留給高價值 tie-break 或最後抽查。

### FR-06 Recall-first 雙層報告

第一層主報告必須：

- 先回答使用者問題。
- 涵蓋所有主要子問題。
- 使用白話、結論、影響與下一步。
- 只呈現會改變判斷的警告。

第二層證據層必須：

- 區分已證實事實、候選資訊、推論與未知。
- 保存來源、驗證狀態、反例與技術細節。
- 可展開，但不可讓主報告依賴使用者閱讀後才能理解。

Coverage Review 必須另行檢查：

- 原始要求是否每一項都被回答。
- 是否有候選內容被過早刪除。
- 是否只剩安全但無用的結論。
- 是否出現重複免責或防禦性任務。

### FR-07 Context Lens 與學習 Branch

- 只在使用者明確選取內容並觸發「深入了解」時啟動。
- 不做全域剪貼簿監控。
- Branch 依序提供：
  1. 一段白話簡介。
  2. 理解當前 context 所需的最少技術概念。
  3. 可選擇的深入技術研究。
- Branch 保留來源 task、選取文字、所在段落與當前目標。
- Branch 本身不直接修改主任務、檔案或外部系統。

### FR-08 帶回主對話

- 使用者可在 Branch 中輸入自然語言，例如「把這個概念加入目前計畫」。
- Branch 產生方向為 `to_main` 的 Context Capsule 並送回原主對話。
- 原主對話依語意判斷：
  - 建立新任務。
  - 修改既有任務。
  - 只記錄為背景資訊。
- 主對話必須複誦理解與目的地。
- 可逆修改在複誦後自動進行；高風險修改等待明確確認。

### FR-09 Open in Codex Review

- 主介面提供 `Open in Codex Review`。
- 系統建立或 fork 一個帶有 Context Capsule 的 Codex task。
- 透過 Codex 原生 review pane／annotation UI 讓使用者選取、批註和要求修改。
- Codex 可在隔離工作區完成修訂。
- 結果以 Review Capsule 回到原主對話。
- 主 Architect 複誦收到的批註、修改目標與未解決問題後再整合。
- v0.1 不自行重做 Codex annotation UI。
- 上述完整 handoff 在通過 runtime capability probe 與往返驗證前，屬於目標能力，不得標示為 production-ready。

### FR-10 Skill 與 Adapter Registry

- 沿用現有 Claude Code／Codex skills。
- v0.1 只登錄、包裝與派工，不搬移、不統一或改寫其內部 prompt。
- 每個 skill 對上層只公開能力契約：
  - 能做什麼。
  - 適合的模型角色。
  - 輸入、輸出與必要 context。
  - 成本、風險、是否可平行。
  - 是否需要使用者確認。
- Adapter 負責呼叫特定 runtime／CLI；Architect 不依賴其內部實作。
- Codex、Claude、Grok 等既有 Firstmate adapters 優先。
- Cursor 與 Gemini 必須先完成 supervised adapter verification，才可列為 production-ready。

### FR-11 Decision Registry

- 已確認的使用者偏好不得在每個 task 重問。
- 每筆決策包含範圍、內容、來源、日期與是否可覆寫。
- 新回答可取代舊偏好，但必須留下 lineage。
- Captain Preference 由結構化設定生成 Firstmate 的 `captain.md`，不要求使用者手工編輯。

## 5. 非功能需求

### 可預期

- 相同風險與任務類型應選到相同 recipe。
- 所有 workflow 具有最大回合、最大 repair 次數與停止條件。

### 可追溯

- 每次派工保留 recipe、角色、model alias、adapter、輸入 capsule 與結果摘要。
- 報告可追溯到 reviewer 與 coverage 結果。

### 中央責任

- Architect 是唯一對使用者承諾結果的 agent。
- worker 之間不建立不可見的責任鏈。

### 漸進揭露

- 預設只顯示一頁架構／結果摘要。
- 技術細節、證據、完整 log 與模型辯論按需展開。

### 可替換

- Firstmate、Herdr、模型供應商與 UI 都透過明確 contract 連接。
- 更換 adapter 不得改變 Decision Policy 與 Workflow Recipe 的語意。

## 6. v0.1 非目標

- 永久 fork 或直接修改 Firstmate main。
- 自行建立完整 agent runtime。
- 自製 Codex review／annotation UI。
- 全域剪貼簿監控。
- 讓 Context Branch 直接取得主任務權限。
- 多使用者 SaaS、組織權限與帳務。
- 一開始就支援所有 CLI 或模型。
- 將模型名稱、價格或供應商額度寫死。

## 7. 驗收情境

### A. 小型可逆修改

系統選擇 `quick`，自動修改與驗證，只回傳簡潔結果，不詢問技術選項。

### B. 架構變更

系統選擇 `adversarial`，由不同模型家族 review 與 challenge，Judge 裁決後才修復與報告。

### C. Recall-first 研究

系統先保留高 recall 候選集合，再分成已證實、候選、推論與未知；Coverage Reviewer 能指出原問題中未回答的部分。

### D. Context Branch

使用者選取一段文字並深入了解；Branch 先簡介，再按需深入，回傳後主對話正確判斷新建或修改任務並複誦。

### E. Codex 原生批註

使用者從主介面開啟 Codex review task，完成 inline annotations；結果回到原主對話且不遺失來源 context。

### F. 模型不可用

Research 模型不可用時自動 fallback；Architect／Judge 只有在所有候選都低於能力下限時才詢問使用者。

## 8. v0.1 完成定義

v0.1 必須同時具備：

- 可執行的 `quick`、`standard`、`adversarial`、`research` recipes。
- Firstmate-on-Herdr 的最小 end-to-end task。
- 至少 Codex 與 Claude 的跨模型 review。
- 結構化 Captain、Decision、Model、Workflow 與 Adapter 設定。
- Context Branch 往返主對話。
- Codex 原生 review handoff。
- Recall-first 雙層報告與 Coverage Review。
- 每項驗收情境具有可回讀的 runtime evidence。
