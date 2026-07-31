# Ari 使用說明

## 先知道三件事

Ari 是 Herdr 裡的一個架構控制入口：

1. 你描述想完成的結果，不需要先拆技術步驟。
2. Firstmate 負責編排 Codex、Claude、Grok 等模型。
3. 你先看到結論、影響與下一步；證據和技術細節留在第二層。

介面與文件稱它為 **Ari**。指令仍使用 `aicoding-mate`；這只是穩定的技術名稱，不代表 Herdr 裡還有第二個產品入口。

v0.3.2 只有一個 Herdr 主入口：在 Herdr shell 輸入 `Ari`，直接於目前 pane 進入；Quick、Standard、Expert、Research 與 Learn 都在同一處切換。底層沿用 v0.2 的 Workflow Authority 與 canonical Run Registry：Firstmate 決定誰做什麼，Adapter 只照單執行；同一個任務被重送時會回到同一 canonical run。

## 安裝與從 Herdr 進入

在 repository 內執行：

```bash
bun install
bun bin/aicoding-mate link
Ari
```

`link` 會同時安裝 Herdr plugin 與 `Ari` launcher。以後只要在任一 Herdr shell 輸入：

```bash
Ari
```

它會在目前 pane 進入 Standard；不會另開 tab。輸入 `/quit` 後回到原 Herdr shell。舊的 `bun bin/aicoding-mate open --mode <mode>` 仍可供 automation 使用，但預設只開 overlay。

第一次使用 Firstmate 前：

```bash
bun bin/aicoding-mate bootstrap-firstmate
```

## 我該選哪一個模式

| 模式 | 何時使用 | 你會先看到什麼 |
| --- | --- | --- |
| Quick | 小型唯讀檢查、搜尋、摘要、解釋 | 任務摘要與真實 worker/read-back 狀態 |
| Standard | 一般架構或功能設計 | Firstmate/Codex 方案與跨模型 review |
| Expert | 高風險架構、需要找反例 | Author、Challenger、Judge 收斂後的結論 |
| Research | 想先廣搜、避免漏掉候選 | recall-first 結論、coverage 與 evidence path |
| Learn | 想先懂大意，再決定是否深入 | 白話簡介與目前真正需要懂的少量概念 |
| Context Branch | 想理解畫面中選取的文字 | 白話簡介，可選深入，再帶回主任務 |
| Codex Review | 想用 Codex 原生 review 介面批註 | 新的 Codex review task 與回傳 capsule |

## Slash commands

開啟 pane 後可使用：

```text
/quick [任務]     切換 Quick；若有任務就立即執行
/standard [任務]  切換 Standard
/expert [任務]    切換 Expert
/research [任務]  切換 Research
/learn [內容]     切換 Learn
/status           顯示目前模式與 context 輪數
/doctor           檢查 Herdr、Firstmate 與模型 runtime
/help             顯示指令
/quit             離開
```

只輸入 `/expert` 會切換模式，不會派工；之後直接輸入文字即可。輸入 `/expert 找出這個方案的反例` 則會切換並立刻執行。

只要本輪會派 agent，Ari 會在 dispatcher 啟動前先顯示 ASCII workflow graph，例如：

```text
派工前 workflow 預覽（expert，尚未執行）：
[你] --> [Firstmate] --> [Author] <--> [Challenger] --> [Judge] --> [報告]
若通過 scope gate，Firstmate 將依當下可用模型決定實際派工。
```

graph 顯示角色與執行順序，不預先假裝知道動態模型分配；只切換模式、查看 `/status` 或 `/help` 時不會出圖。

同一 pane 會保留最近四輪摘要作為畫面內的短期 continuity。系統把本輪 `currentTask` 和歷史 `continuityContext` 分開：只有本輪文字會進入 Firstmate decision、scope gate、run identity 與 worker。舊回合不會被暗中當成新指令；如果新任務確實需要沿用某項決策，請在本輪用一句話複誦，或用 Context Branch 經確認後帶回。關閉 pane 後不保留這段短期 continuity；正式 run、evidence 與 lineage 仍在 Run Registry。

## Quick

在 pane 輸入 `/quick`。

輸入一個明確唯讀任務，例如：

```text
說明這個 repository 的三層架構，不要修改檔案。
```

Quick 只有在以下四件事都被實際讀回後才算完成：

- Firstmate 確實在 Herdr 中執行。
- worker pane 可見。
- 結果回到來源 pane。
- durable record 與 pane 內容一致。

## Standard

在 pane 輸入 `/standard`。

你只需要描述目標與邊界。系統會先由 Firstmate/Codex 形成方案，再由不同模型家族 review。若 Claude/Fable 被顯式停用，報告會清楚標示同家族 fallback，不會假裝已完成跨模型 review。

## Expert

在 pane 輸入 `/expert`。Expert 的底層 recipe 名稱仍是 `adversarial`，因此既有 CLI automation 與 durable record 名稱不變。

適合「選錯會有明顯代價」的架構決策。預設角色：

- Author：Codex Sol
- Challenger：Claude Fable
- Judge：Cursor Grok

Firstmate 決定 assignments；Adapter 只執行指定模型。辯論最多兩輪，避免無止境來回。

可從 CLI 增加你在意的子問題：

```bash
bun bin/aicoding-mate adversarial \
  --task "判斷這個控制平面的 authority 邊界" \
  --question "Adapter 是否可能成為第二個決策者？"
```

## Research

在 pane 輸入 `/research`。

Research 會保留 discovery denominator，並把內容區分為：

- 已確認
- 候選
- 推論
- 未知

主畫面只顯示結論、影響、下一步與 evidence 路徑。完整來源、coverage、模型輸出與 lineage 留在 JSON record。

## Learn

在 pane 輸入 `/learn`，再貼上數字、文字或概念；也可以直接輸入：

```text
/learn 什麼是 idempotency？它為什麼和這個控制平面有關？
```

Learn 會先給短簡介，再列出本輪問題真正需要理解的少量技術概念。它重用 Standard workflow 與 review，不另建低可信度的簡化 runtime。若想深入，直接在同一 pane 追問；需要引用前輪某項決策時，在新問題中簡短複誦即可。

## Context Branch

1. 在 Herdr 選取一段文字。
2. 執行「用 Ari 深入了解選取內容」。
3. Branch 先給白話簡介。
4. 輸入 `d` 才進一步研究技術細節。
5. 告訴 Branch 要如何帶回主任務。
6. 系統最後複誦；只有輸入「確認」才送回。

送回後會依語意建立新任務或修改原任務。Branch 不直接取得主任務修改權。

## Codex native review

在 Herdr 選取內容後執行「Open in Codex Review」。系統會：

1. 重新解析來源 Firstmate task/run。
2. 建立 detached Codex review thread，並保存 stable start receipt。
3. 等待 app-server 回報同一 review turn completed。
4. 讀回 review 文字並寫入 Review Capsule。
5. 請求 macOS 開啟 `codex://threads/<thread-id>`。

若 review turn 被 Codex 標成 `interrupted`，Ari 會保留同一 thread 與 canonical run，回報 `review_not_completed`，不會自動建立第二個 review。你可以直接在已開啟的 Codex task 繼續；但人工 follow-up 是新的 turn，目前不會被偽裝成原受管 turn 的 capsule。

CLI 只能把 desktop deep-link 標成 `requested_unverified`。2026-07-31 的實機 QA 另由 Codex desktop connector 觀測到同一 thread 已成功打開；這是 QA evidence，不是 CLI 本身的永久能力保證。

## 模型設定

High-intensity 預設：

```text
Author      gpt-5.6-sol-high
Challenger  claude-fable-5-thinking-high
Judge       cursor-grok-4.5-high
```

可以用環境變數改變上層 policy，例如：

```bash
export ACM_HIGH_INTENSITY_AUTHOR_MODEL=gpt-5.6-sol-high
export ACM_HIGH_INTENSITY_CHALLENGER_MODEL=claude-fable-5-thinking-high
export ACM_HIGH_INTENSITY_JUDGE_MODEL=cursor-grok-4.5-high
```

Codex native review：

```bash
export ACM_CODEX_REVIEW_MODEL=gpt-5.6-sol
export ACM_CODEX_REVIEW_REASONING_EFFORT=high
```

這些值由控制層解析後交給 Adapter；Adapter 不可自行換模型。

## 如何看結果

一般情況只看主報告：

- 結論
- 影響
- 下一步

需要稽核時才打開 `evidence:` 指向的 JSON。若畫面顯示 `BLOCKED`，代表成功條件未被證明；不要只看 worker 曾經啟動或 terminal 沒有報錯。

受管 Standard／Adversarial／Research record 可以用同一個 CLI 讀回：

```bash
bun bin/aicoding-mate read-run <record.json>
```

CLI 只接受本次 invocation 解析出的單一 Firstmate authority root。若 run 是在自訂 `FM_HOME` 下建立，讀回時必須提供同一個 `FM_HOME`；它不會搜尋或信任第二個隱含 root。舊 Quick record 沒有 signed authority receipt，仍可閱讀，但會回報 `quick_record_historical_unverified` 與非零 exit code。

## v0.2 現在如何運作

v0.2 有兩個核心：

- Workflow Authority：Firstmate 是 Author、Reviewer、Judge、Report Composer 與 fallback 的唯一決策者。
- Runtime Authority：同一 intent 只對應一個 canonical run；重送、timeout、crash 都先經 registry reconciliation。

你通常不需要看 authority store 或 registry。只有想稽核或排錯時，才查看：

```text
<FM_HOME>/aicoding-mate-authority/
├── identity/
│   ├── ed25519-private.pem
│   └── ed25519-public.pem
├── decisions/<workflow-decision-id>.json
└── receipts/<workflow-decision-id>.json
```

不要分享 `ed25519-private.pem`。一般稽核只需 decision、receipt 與 public key；系統會自動核對 decision artifact hash、public-key fingerprint 與 signature。沒有 `FM_HOME` 時，authority store 位於 `state/aicoding-mate/firstmate-authority/`。

```text
state/aicoding-mate/run-registry/runs/<canonical-run-id>/
├── projection.json
├── events.jsonl
└── lease/lease.json
```

`projection.json` 是目前 canonical 狀態；`events.jsonl` 是 append-only hash-chain 歷史。若 event 比 projection 正好多一筆且 chain／payload 可完整驗證，系統會 deterministic replay；若最後只有一行不完整 JSON，只有在前綴與 projection 完全一致時才截除。多筆 event ahead、hash tamper 或 schema 不明一律 fail closed。

若狀態是 `unknown_outcome`，代表外部工作可能已被接受但 receipt 未完整保存，系統會先 read back，不會冒險派第二次。缺少本機 receipt 不代表 provider 已證明 `not_found`，因此不會自動重派。

受管 workflow 的結果會帶兩個 authority 標記：

```text
workflowAuthority: firstmate_verified
runtimeAuthority: canonical_run_registry_verified
```

這兩個標記只有在 signed decision receipt、artifact、registry 與 lineage 互相吻合時成立。若 decision issuance 失敗，畫面只會顯示 `unverified`，且不會先派模型。Quick 是 Firstmate 的下游 primitive，接收同一個 idempotency key；Context Branch 是一次性確認 handoff，不會成為另一個決策者。

Standard 的原始目標會以明文進入 scope gate。你可以討論「deploy、寫入、credential」等架構風險；但若要求 worker 實際修改、推送或連線，Standard 會在派工前阻擋。需要真正修改時，應由主對話建立新的 implementation task，而不是把 Standard review 偷偷升級成寫入流程。

## 排錯

先執行：

```bash
bun bin/aicoding-mate doctor
```

常見狀態：

- `agent_list_models_failed`：Cursor Agent CLI 不可用或未登入。
- `model_not_listed`：設定的 model 不在目前訂閱可用清單。
- `app_server_unavailable`：Codex app-server 未啟動、timeout 或協定回讀失敗。
- `review_not_completed`：Codex thread 已建立，但原受管 review turn 未完成或被中斷；請打開既有 task 檢查，不要重新點擊製造另一個 intent。
- `firstmate_source_run_not_found`：selection 不屬於可重新解析的 Firstmate source run。
- `durable_readback_failed`：record 未成功寫入或內容不符合 schema。
- `run_lease_unavailable`：同一 canonical run 已有另一個程序持有執行權；目前程序不會重複派工。
- `unknown_outcome`：外部接受狀態不明；必須先完成 read-back reconciliation。
- `firstmate_decision_issuance_failed`：Firstmate decision 或簽章 receipt 無法持久化並讀回；任何 Adapter 都尚未啟動。
- `author_scope_invalid`：Standard 原始目標包含可執行寫入或外部動作；請改成唯讀分析，或另建 implementation task。

系統遇到這些狀態會 fail closed，不會把部分完成包裝成成功。

Herdr selection action 正式傳入的是 `HERDR_PLUGIN_CONTEXT_JSON`。一般使用者不需要手動設定；只有從 terminal 重現 action 時才會看到這個變數。`HERDR_ACTION_CONTEXT_JSON` 不是目前 plugin contract。
