# AI Coding Mate 共用契約

這份文件固定 T3 Standard workflow 與 T4 Context Branch 共用的邊界。實作者可以在自己的模組內選擇實作方式，但不得改變這些跨模組語意。

## Routing

派工不是只由 prompt 與設定檔決定。可重現的輸入是：

```text
normalized input hash
+ config version hash
+ availability snapshot
```

availability snapshot 必須記錄當下可用的 alias、provider family、實際解析模型、能力層級與 quota 狀態。即使 snapshot ID 相同，只要內容變化，routing key 也必須改變。

workflow recipe 只引用 `modelAlias`，不可寫死 provider model ID。解析後的實際模型與 fallback trace 才寫入 `RoutingDecision`。跨 family review 無法滿足時，只能以 `degraded_same_family` 明確揭露；所有候選都低於角色能力下限時，回到使用者確認，不得靜默降級。

## 雙層報告

主報告只保留架構師要做決策所需的三件事：

1. 結論
2. 影響
3. 下一步

證據層另存 config、availability、routing lineage、限制與未知項目。主報告或核心 lineage 缺漏時，報告不是 decision-ready。

## Firstmate dispatch

T3 只能透過 `FirstmateDispatchPort` 交付已解析的 Standard 任務。request 必須帶 idempotency key、來源 lineage 與完整 routing decision；receipt 必須回傳 Firstmate task、worker target 與 evidence path。

root integration owner 負責把此 port 接到既有 T2 Quick dispatch seam。T3 實作者不得自行複製或改寫 T2 的 Herdr／Firstmate lifecycle。

## Confirmed Context Capsule

Context Branch 的深度研究內容留在 branch 內。主對話只允許三種摘要事件：

- `brief`
- `recitation`
- `confirmation_result`

selection 上限為 8,000 個 Unicode code points；超過上限直接回傳 `failed_closed`，不得靜默截斷。帶回主對話的 capsule 必須已經完成語意複誦與明確確認。

注入 adapter 必須在同一個原子操作內重新解析來源 task/run/workspace/tab/pane、比對 lineage，再寫入指定 Firstmate session。先檢查再另行送出的兩步驟實作不符合契約。capsule 是一次性資源；pane 被重用、session 改變、duplicate send 或 read-back hash 不符都必須拒絕。

## Ownership

- root integration owner：`src/contracts/`、T2 dispatch wrapper、跨模組 integration tests。
- T3 owner：`src/config/`、`src/routing/`、`src/report/standard/` 與對應單元測試。
- T4 owner：`src/branch/` 與對應單元測試。

若 T3 或 T4 需要改變共用契約，應停止該變更並回報 root integration owner，不得跨 ownership 直接修改。
