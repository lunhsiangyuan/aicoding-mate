# Codex Review Handoff 可行性

- 狀態：Issue #2 read-only spike
- 日期：2026-07-30
- 本機 Codex CLI：`codex-cli 0.145.0`
- 結論：`FEASIBLE_WITH_CAPSULE_FALLBACK`

## 1. 判斷摘要

Ari v0.1 可以把 Codex 原生 review handoff 當成增強路徑，但不能把它當成唯一完成路徑。

目前可由本機 CLI、version-matched generated schema、官方 OpenAI docs 和官方 `openai/codex` source 證實的是：

- `codex app-server` 存在，支援 JSON-RPC over `stdio://`、Unix socket、WebSocket，以及 version-matched schema generation。
- app-server protocol 包含 `thread/start`、`turn/start`、`thread/read`、`review/start`。
- `review/start` 支援 `inline` 與 `detached` delivery，且 response 內有 `reviewThreadId`。
- official desktop command docs 列出 `codex://threads/<thread-id>` 為 canonical deep link，可以打開指定 technical thread id 的 local chat。
- `codex review` CLI 存在，可針對 uncommitted changes、base branch、commit 或 custom prompt 執行非互動式 code review。

本輪沒有建立新的 Codex task，也沒有啟動實際 review 往返，因為本 spike 被明確限制為 read-only 且不得建立新 Codex task。因此以下能力仍是 `UNVERIFIABLE`，不能標示為 production-ready：

- 外部 app-server 建立或 detached 的 review thread 是否一定會在目前安裝的 ChatGPT/Codex Desktop 以完整原生 review UI 顯示。
- `codex://threads/{reviewThreadId}` 是否在所有目標版本中都會打開同一個剛由外部 app-server 回傳的 review thread。
- 使用者在 Desktop/browser/review pane 手動留下的 inline annotations 是否有公開、穩定、結構化 export surface 可由外部 Herdr plugin 讀回。

v0.1 因此應採「app-server JSON-RPC + `codex://threads/{id}` + Review Capsule fallback」：能打開原生 Codex review 就打開；不論原生 UI 是否成功，都必須能從 app-server event/read-back 或 CLI review 產生 Review Capsule，回到 Firstmate 主 session。

## 2. 本機 CLI 證據

### `codex --version`

```text
codex-cli 0.145.0
```

### `codex app-server --help`

本機 help 顯示：

- `codex app-server` 是 experimental app server surface。
- transport 支援 `stdio://` default、`unix://`、`unix://PATH`、`ws://IP:PORT`、`off`。
- 提供 `generate-ts` 與 `generate-json-schema`，可產生與目前 CLI 版本相符的 protocol bindings/schema。

這支持 v0.1 probe 應以「當下安裝的 Codex CLI」產生 schema，而不是把 schema 靜態 vendored 進 repo。

### `codex review --help`

本機 help 顯示 `codex review [OPTIONS] [PROMPT]`，支援：

- custom prompt，或 `-` 從 stdin 讀取。
- `--uncommitted`
- `--base <BRANCH>`
- `--commit <SHA>`
- `--title <TITLE>`

這可作為 Review Capsule fallback 的本機 review runner，但 help 沒有顯示它會回傳 app-server thread id；不可把 `codex review` 等同於原生 Desktop review handoff。

### generated schema probe

本輪執行：

```text
codex app-server generate-json-schema --out <tmpdir>
codex app-server generate-ts --out <tmpdir>
```

version-matched generated TS 顯示：

```ts
export type ReviewDelivery = "inline" | "detached";
export type ReviewStartParams = {
  threadId: string;
  target: ReviewTarget;
  delivery?: ReviewDelivery | null;
};
export type ReviewStartResponse = {
  turn: Turn;
  reviewThreadId: string;
};
```

generated schema 也顯示 `ThreadReadParams` 有 `includeTurns?: boolean`，`TurnStartParams` 需要 `threadId` 與 `input`，`ThreadStartParams` 可帶 `cwd`、`model`、`approvalPolicy`、`sandbox`、`serviceName` 等欄位。

### Existing-thread deep-link probe

Root integration review 另外以本 session 的既有 Codex task id 執行 macOS `open codex://threads/<existing-thread-id>`，command exit 0；Codex App 的同一 task navigation read-back 回傳 `navigated: true`。因此「canonical deep link 能打開一個已知存在的本機 task」已取得 runtime 證據。

這不證明外部 app-server 新建的 detached review thread 一定會出現在 Desktop，也不證明該 thread 的原生 annotations 可匯出。那兩項仍維持 `UNVERIFIABLE`，留給後續 runtime ticket。

## 3. 官方 docs/source 證據

### OpenAI docs

- [Codex App Server](https://developers.openai.com/codex/app-server) 說明 app-server 是 Codex 用來支撐 rich clients 的 interface，適合深度整合 authentication、conversation history、approvals、streamed agent events；protocol 是 JSON-RPC 2.0，支援 stdio、WebSocket、Unix socket transports。
- [Codex App Server - lifecycle/API](https://learn.chatgpt.com/docs/app-server) 列出 `initialize`/`initialized`、`thread/start`、`turn/start`、event stream、`turn/completed` 的基本 lifecycle。
- [Codex App Server - `thread/read`](https://learn.chatgpt.com/docs/app-server) 說明 `thread/read` 可在不 resume、不 subscribe 的情況下讀 stored thread；`includeTurns: true` 會回傳 turns。
- [Codex App Server - Review](https://learn.chatgpt.com/docs/app-server) 說明 `review/start` 會啟動 Codex reviewer；target 包含 `uncommittedChanges`、`baseBranch`、`commit`、`custom`；`delivery: "inline"` 在既有 thread 上跑，`delivery: "detached"` 會 fork new review thread；response 含 `reviewThreadId`，完成時會產生 `exitedReviewMode` item。
- [Commands - deep links](https://developers.openai.com/codex/reference/commands) 將 `codex://threads/<thread-id>` 列為 canonical deep link，用於打開 technical thread id 對應的 local chat。
- [Troubleshooting](https://developers.openai.com/codex/reference/troubleshooting) 明確提醒 ChatGPT desktop app 與 Codex CLI 可能包含不同 Codex versions，功能可能先到 CLI；因此 Desktop handoff 必須獨立 runtime probe。
- [Work with files - annotations](https://developers.openai.com/codex/artifacts-viewer) 說明 annotations 可讓使用者指向 file/preview 的特定區域並要求修訂；但該頁沒有提供外部 structured export protocol。

### OpenAI source-reference

- [openai/codex `codex-rs/app-server/README.md`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 是 app-server protocol 的 upstream README；GitHub API 於本輪讀到 SHA `680e223e764c5e1535f8fe5970fe59d49e4f0a4a`。
- [openai/codex `ClientRequest.json`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/ClientRequest.json) 在官方 generated schema 中包含 `thread/start`、`thread/read`、`turn/start`、`review/start`；本輪讀到 SHA `b2cbff661bd5ce566f820b23daa767be44f27593`。
- [openai/codex `ReviewStartParams.json`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ReviewStartParams.json) 定義 `threadId`、`target`、`delivery`；`delivery` 說明 inline default 或 detached new thread，detached thread 會在 `reviewThreadId` 回傳；本輪讀到 SHA `0089d46491acda3d9c4e9f138e8fc4b686c89397`。
- [openai/codex `ReviewStartResponse.json`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ReviewStartResponse.json) 定義 `turn` 與 `reviewThreadId`；說明 inline 時為 original thread id，detached 時為 new review thread id；本輪讀到 SHA `0169150eee4af467a1e60bd5dfcae2e055a7bf04`。
- [openai/codex `ThreadReadParams.json`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/json/v2/ThreadReadParams.json) 定義 `threadId` 與 `includeTurns`；本輪讀到 SHA `5fb1bcc17b08c91f8a304cdbe833f1836564fe51`。

舊 artifact 提到的 `codex-rs/app-server-protocol/src/protocol.rs` 在本輪以 GitHub REST contents 查詢得到 404；目前應引用 `schema/json/*` 與 `schema/json/v2/*` path，而不是沿用該舊 path。

## 4. 三種能力不可混用

| 能力 | 本輪狀態 | 可以主張什麼 | 不可主張什麼 |
| --- | --- | --- | --- |
| thread/review result read-back | `CONFIRMED_BY_DOCS_AND_SCHEMA`，runtime 往返 `UNVERIFIABLE` | app-server 有 `thread/read includeTurns`；`review/start` streams review items，完成時有 `exitedReviewMode.review` text；detached review 回 `reviewThreadId` | 不可主張本輪已實際建立 review thread 並讀回結果 |
| Desktop deep link | `CONFIRMED_FOR_EXISTING_THREAD`；外部新建 review thread 仍為 `UNVERIFIABLE` | `codex://threads/<thread-id>` 是官方 canonical link form，且本機已打開一個既有 task | 不可主張它已在本機打開外部 app-server 剛建立的 review thread，也不可主張 Desktop/CLI version 一定一致 |
| user-authored inline annotation structured export | `UNVERIFIABLE_PUBLIC_EXPORT` | 官方 docs 證明 annotation UX 存在，可作為人工修訂入口 | 不可主張外部 plugin 可穩定讀出 structured file/line/user-comment annotations；必須 fallback 到 Review Capsule |

## 5. v0.1 建議整合路徑

### 5.1 Capability probe

每次啟用 Codex adapter 前先跑：

1. `codex --version`，記錄 exact version。
2. `codex app-server --help`，確認 `--stdio`、`--listen`、`generate-ts`、`generate-json-schema` 存在。
3. `codex review --help`，確認 fallback review targets。
4. `codex app-server generate-json-schema` 到 ephemeral temp dir，檢查：
   - `ClientRequest.json` 包含 `thread/start`、`turn/start`、`thread/read`、`review/start`。
   - `ReviewStartResponse` 包含 string `reviewThreadId`。
   - `ReviewStartParams.delivery` 包含 `inline`/`detached`。
   - `ThreadReadParams.includeTurns` 存在。

Probe output 寫入本地 run registry，不寫入 upstream Firstmate clone。

### 5.2 JSON-RPC path

1. Herdr plugin 啟動 Ari terminal plugin。
2. Adapter 以 child process 啟動：

   ```text
   codex app-server --stdio
   ```

3. 送 `initialize`，再送 `initialized` notification。
4. 針對一般 handoff 建立 thread：

   ```json
   {
     "method": "thread/start",
     "id": 1,
     "params": {
       "cwd": "/absolute/project",
       "approvalPolicy": "never",
       "sandbox": "readOnly",
       "serviceName": "aicoding-mate"
     }
   }
   ```

5. 用 `turn/start` 注入 Context Capsule，或在 review path 使用 `review/start`：

   ```json
   {
     "method": "review/start",
     "id": 2,
     "params": {
       "threadId": "<source-thread-id>",
       "delivery": "detached",
       "target": {
         "type": "custom",
         "instructions": "<review instructions plus Context Capsule summary>"
       }
     }
   }
   ```

6. 儲存 `threadId`、`reviewThreadId`、target、prompt hash、selected context hash、event ids、Codex version、schema probe hash。
7. 消費 stream events；遇到 `exitedReviewMode` 時暫存 reviewer text。
8. 以 `thread/read` + `includeTurns: true` 對 `reviewThreadId` 做 read-back，確認 thread id、turn id、review text/event lineage 一致。
9. 只有在 read-back 成功後才把 result materialize 成 Review Capsule。
10. 若使用者要求原生 UI，顯示或開啟：

    ```text
    codex://threads/<reviewThreadId>
    ```

### 5.3 Review Capsule fallback

即使 native Desktop handoff 成功，也要產生 capsule；native annotation export 未被公開證實前，capsule 是唯一 v0.1 required completion artifact。

必要欄位：

```yaml
capsule_version: 1
source:
  aicoding_mate_run_id: string
  source_thread_id: string | null
  review_thread_id: string | null
  codex_version: string
  schema_probe_hash: string
target:
  kind: uncommittedChanges | baseBranch | commit | custom
  ref: string | null
  cwd: absolute_path
context:
  selected_text: string | null
  source_artifact: string | null
  context_hash: string
review:
  delivery: inline | detached | cli_fallback
  status: completed | failed | unverifiable
  raw_review_text: string
  findings:
    - severity: critical | high | medium | low
      file: string | null
      line: integer | null
      body: string
      source: codex_review_text | user_annotation | manual_import
  unresolved_questions:
    - string
verification:
  thread_read_back: confirmed | failed | unverifiable
  desktop_deeplink: confirmed | failed | unverifiable
  native_annotation_export: confirmed | failed | unverifiable
lineage:
  event_ids:
    - string
  imported_at: iso8601
```

如果 app-server path 不可用，fallback runner 可用 `codex review` 產生 `raw_review_text`，再由 Ari normalization layer 萃取 findings；此時 `review.delivery = cli_fallback`，`review_thread_id = null`，`desktop_deeplink = unverifiable`。

## 6. No-go gates

以下任一條成立時，不得宣稱 Codex native review handoff production-ready：

1. `codex app-server --help` 不存在或缺少 usable transport。
2. version-matched schema 不含 `review/start`、`ReviewStartResponse.reviewThreadId`、`ReviewDelivery.detached` 或 `thread/read.includeTurns`。
3. `review/start delivery=detached` 沒有回傳可記錄的 `reviewThreadId`。
4. `thread/read includeTurns=true` 無法讀回 review thread 或無法定位 completed review output。
5. `codex://threads/{reviewThreadId}` 打不開、打開錯 thread，或 Desktop 與 CLI version mismatch 導致該 thread 不可見。
6. 沒有公開、穩定的 structured annotation export surface，卻試圖把使用者手動 inline annotations 當成已可機器讀回。
7. Review Capsule 無法記錄 source run、source context、target、raw review text、finding normalization 和 verification status。
8. Bad thread id、missing app-server、unsupported schema、permission failure 等負向案例出現 false success。

No-go 觸發時，產品仍可完成 v0.1 review workflow，但必須走 Review Capsule fallback，並在 UI 中把 native handoff 標成 `UNVERIFIABLE` 或 unavailable，而不是失敗後靜默假裝成功。

## 7. 後續 runtime 驗證票建議

下一張 implementation ticket 應在隔離測試 repo 與 temp Codex home 中做真實往返：

1. 啟動 `codex app-server --stdio`。
2. `initialize`/`initialized`。
3. `thread/start` 建立 source thread。
4. `review/start delivery=detached target=custom` 或針對測試 commit。
5. 捕捉 `reviewThreadId`。
6. 等待 `exitedReviewMode`。
7. `thread/read includeTurns=true` 讀回 review result。
8. 使用 `codex://threads/{reviewThreadId}` 打開 Desktop，人工或 Playwright/AppleScript 可觀察時確認 thread id/標題。
9. 若手動留下 inline annotation，檢查 app-server read-back、local session transcript、public docs/source 是否出現 stable structured record。
10. 匯入 Review Capsule，跑 bad id/missing CLI/schema mismatch negative cases。

驗證通過前，FR-09 的「Codex 原生批註」只能列為 target capability；v0.1 的 required completion path 是 Review Capsule round-trip。
