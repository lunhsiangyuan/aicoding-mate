# AI Coding Mate 使用說明

## 先知道三件事

AI Coding Mate 是 Herdr 裡的一個架構控制入口：

1. 你描述想完成的結果，不需要先拆技術步驟。
2. Firstmate 負責編排 Codex、Claude、Grok 等模型。
3. 你先看到結論、影響與下一步；證據和技術細節留在第二層。

v0.2 的單一 Workflow Authority 與 canonical Run Registry 已列入規格，但尚未宣稱完成。

## 安裝與從 Herdr 開啟

在 repository 內執行：

```bash
bun install
bun bin/aicoding-mate link
bun bin/aicoding-mate open
```

若要直接進入某個工作面：

```bash
bun bin/aicoding-mate open --entrypoint quick
bun bin/aicoding-mate open --entrypoint standard
bun bin/aicoding-mate open --entrypoint adversarial
bun bin/aicoding-mate open --entrypoint research
```

第一次使用 Firstmate 前：

```bash
bun bin/aicoding-mate bootstrap-firstmate
```

## 我該選哪一個入口

| 入口 | 何時使用 | 你會先看到什麼 |
| --- | --- | --- |
| Quick | 小型唯讀檢查、搜尋、摘要、解釋 | 任務摘要與真實 worker/read-back 狀態 |
| Standard | 一般架構或功能設計 | Firstmate/Codex 方案與跨模型 review |
| Adversarial | 高風險架構、需要找反例 | Author、Challenger、Judge 收斂後的結論 |
| Research | 想先廣搜、避免漏掉候選 | recall-first 結論、coverage 與 evidence path |
| Context Branch | 想理解畫面中選取的文字 | 白話簡介，可選深入，再帶回主任務 |
| Codex Review | 想用 Codex 原生 review 介面批註 | 新的 Codex review task 與回傳 capsule |

## Quick

從 Herdr 開啟：

```bash
bun bin/aicoding-mate open --entrypoint quick
```

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

```bash
bun bin/aicoding-mate open --entrypoint standard
```

你只需要描述目標與邊界。系統會先由 Firstmate/Codex 形成方案，再由不同模型家族 review。若 Claude/Fable 被顯式停用，報告會清楚標示同家族 fallback，不會假裝已完成跨模型 review。

## Adversarial

```bash
bun bin/aicoding-mate open --entrypoint adversarial
```

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

```bash
bun bin/aicoding-mate open --entrypoint research
```

Research 會保留 discovery denominator，並把內容區分為：

- 已確認
- 候選
- 推論
- 未知

主畫面只顯示結論、影響、下一步與 evidence 路徑。完整來源、coverage、模型輸出與 lineage 留在 JSON record。

## Context Branch

1. 在 Herdr 選取一段文字。
2. 執行「用 AI Coding Mate 深入了解選取內容」。
3. Branch 先給白話簡介。
4. 輸入 `d` 才進一步研究技術細節。
5. 告訴 Branch 要如何帶回主任務。
6. 系統最後複誦；只有輸入「確認」才送回。

送回後會依語意建立新任務或修改原任務。Branch 不直接取得主任務修改權。

## Codex native review

在 Herdr 選取內容後執行「Open in Codex Review」。系統會：

1. 重新解析來源 Firstmate task/run。
2. 建立 detached Codex review thread。
3. 等待 app-server 回報同一 review turn completed。
4. 讀回 review 文字並寫入 Review Capsule。
5. 請求 macOS 開啟 `codex://threads/<thread-id>`。

產品可以確認 review thread 與 durable capsule，但目前無法由 CLI 證明桌面視窗最後停在同一 thread，因此 UI launch 會標示 `requested_unverified`，不會誤寫成已觀測成功。

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

## v0.2 會改變什麼

v0.2 有兩個核心：

- Workflow Authority：Firstmate 是 Author、Reviewer、Judge、Report Composer 與 fallback 的唯一決策者。
- Runtime Authority：同一 intent 只對應一個 canonical run；重送、timeout、crash 都先經 registry reconciliation。

在 v0.2 完成前，v0.1 的 individual durable records 仍可能無法阻止跨程序重複 dispatch。這是已知架構限制，不是使用方式問題。

## 排錯

先執行：

```bash
bun bin/aicoding-mate doctor
```

常見狀態：

- `agent_list_models_failed`：Cursor Agent CLI 不可用或未登入。
- `model_not_listed`：設定的 model 不在目前訂閱可用清單。
- `app_server_unavailable`：Codex app-server 未啟動、timeout 或協定回讀失敗。
- `firstmate_source_run_not_found`：selection 不屬於可重新解析的 Firstmate source run。
- `durable_readback_failed`：record 未成功寫入或內容不符合 schema。

系統遇到這些狀態會 fail closed，不會把部分完成包裝成成功。
