# Ari QA Evidence

本文件保存 2026-07-31 在 macOS、Herdr 與 Codex Desktop 的實機 gate。它區分「已證明」「部分成功」「未證明」，不以測試綠燈或 task 曾啟動取代 runtime read-back。

## v0.3.3 home-shell launcher root 修正

使用者在 Herdr home shell `w1R:p1` 啟動 v0.3.2 後，Standard 把 `/Users/lunhsiangyuan` 同時當成 app state root 與 project root，因而誤報 Firstmate distro、七個工具、git checkout 與來源 pane 全部失效。live `herdr api snapshot` 同時證明 `w1R:p1` 實際存在且為 focused pane；根因不是安裝缺失，而是 launcher 的 cwd authority 混用。

v0.3.3 重新 link 並先以 `/quit` 結束舊 Ari process 後，在同一個 `w1R:p1` shell 再輸入 `Ari`：

- banner 讀回目前 project 為本 repository，並清楚標示 home 不是 git checkout、已使用 Ari repository。
- `process-info` 讀回前景為 `bun /Users/lunhsiangyuan/.local/bin/Ari`，shell PID 仍是原本 `73899`。
- `/quick 修改檔案` 先顯示 Quick ASCII graph，之後只留下預期的 scope blocker；沒有 Firstmate、toolchain、git root 或 pane blocker。
- 最終重啟後的 Quick durable record 為 `state/aicoding-mate/runs/quick-20260731t141843775z.json`；其中 Firstmate root 與 `FM_HOME` 都位於本 repository 的 app-owned state。
- `/standard 刪除所有檔案` 先顯示 Standard ASCII graph，之後只留下預期的 `author_scope_invalid`；evidence 位於本 repository 的 `state/aicoding-mate/standard-runs/`，未回到 `/Users/lunhsiangyuan/state`。
- `w1R` 全程只有 `p1`，兩個受控拒絕都沒有建立 worker、tab 或 pane；Ari 最後保留在同一 pane 的 Standard prompt。

Automated gate：

- `bun test`：189 pass、0 fail、882 assertions。
- `bun run typecheck`：exit 0。
- launcher regression 同時覆蓋非 git home fallback 與 git 子目錄收斂至 checkout root。
- pane regression 讓 Firstmate root 與 project 故意不存在、Herdr snapshot 保持來源 pane 存在，證明系統保留兩個真 blocker，但不再誤報 pane 不存在。

### v0.3.3 review 與 debugging gate

完整 diff review 未發現 authority、registry、decision 或 adapter routing 漂移；變更只處理 launcher context、preflight probe cwd、兩個回歸與使用說明。環境中沒有 `review-work` 或 `debugging` executable，因此以完整 diff inspection、full suite、真實 Herdr surface 與下列 runtime hypotheses 完成同等 gate。

Claude Fable 5 的唯讀 second opinion 先後以 thinking／ask 兩條 Cursor Agent CLI 路徑執行；兩者在 bounded wait 內均為零輸出，最後由本流程中止為 exit 130。這兩次嘗試只記為 `inconclusive`，不列入 review 通過證據，也沒有修改 workspace。

| 假設 | runtime 證據 | 判定 |
| --- | --- | --- |
| home shell 仍會把 Ari state 寫到 `/Users/lunhsiangyuan/state` | 新 Quick／Standard evidence 均位於本 repository 的 `state/aicoding-mate` | 否 |
| home 仍會被當成 Quick／Standard project | banner 明示使用 Ari repository；Quick preflight 不再出現 `Quick project 必須是 git checkout root：/Users/lunhsiangyuan` | 否 |
| Firstmate probe 失敗仍會連帶誤報 live source pane | `w1R:p1` live snapshot／process-info 存在；實機 Quick 無 pane blocker，受控 regression 也只保留 Firstmate blocker | 否 |

## v0.3.2 current-pane 入口與 workflow graph gate

2026-07-31 重新 link 後，Herdr receipt 讀回 plugin `0.3.2`、主 pane compatibility placement `overlay`；同一操作在 `/Users/lunhsiangyuan/.local/bin/Ari` 建立指向本 repository `bin/Ari` 的 launcher。

真實 Herdr surface：

- 驗收來源是既有 shell pane `w1N:pB`；環境讀回 `HERDR_PANE_ID=w1N:pB`、`HERDR_TAB_ID=w1N:t7`、`HERDR_WORKSPACE_ID=w1N`。
- 輸入 `Ari` 前，workspace `w1N` 有 `p1`、`p4`、`pB` 三個 panes；輸入後仍是同三個，沒有建立新 tab 或 pane。
- `pB` 直接讀回 `Ari`、`目前模式：standard` 與 `[standard] >`；`process-info` 顯示前景為 `bun /Users/lunhsiangyuan/.local/bin/Ari`，底層 shell 仍是原 `zsh` PID `89235`。
- 輸入 `/quick 修改檔案` 時，先讀回 Quick ASCII graph，再讀回 scope blocker；workspace pane 數量沒有增加，未建立 worker，也沒有呼叫付費模型。
- 只輸入 `/expert` 後讀回模式切換與 `/status`，沒有顯示假 workflow graph，也沒有派工。
- `/quit` 後同一 `pB` 的前景回到原 `zsh` PID `89235`；再次輸入 `Ari` 後回到 Standard prompt，並保持開啟供使用者操作。

Automated gate：

- `bun test`：187 pass、0 fail、871 assertions。
- `bun run typecheck`：exit 0。
- launcher regression 證明無參數 `Ari` 直接進入 console；link regression 證明 launcher 指向目前 repository，遇到未知同名檔案時不覆寫。
- pre-dispatch ordering regression 在 dispatcher callback 內讀回既有 stdout，證明 graph 在 callback 前已出現。
- 五個模式各有不同 graph；`open` compatibility regression 證明未指定 placement 時使用 overlay。

### v0.3.2 review 與 debugging gate

- Root scope review：變更只涉及 current-pane launcher、UI preview、相容 placement、測試與文件；Firstmate decision、Adapter、Run Registry、state path 與 lineage schema 未變。
- 未發現剩餘 P0／P1／P2；launcher 對既有未知 `Ari` 路徑 fail closed，不覆寫使用者程式。

| 假設 | runtime 證據 | 判定 |
| --- | --- | --- |
| 輸入 `Ari` 仍暗中建立新 pane／tab | `w1N` 在輸入前後都只有 `p1`、`p4`、`pB` | 否 |
| inline launcher 遺失 Herdr source identity，導致結果無法回送 | `pB` 讀回完整 Herdr workspace／tab／pane identity；Quick blocker 與結果都回到同一 pane | 否 |
| graph 在 dispatcher 後才補印，或 graph 本身觸發 worker | 實機先看到 graph 再看到 scope blocker且 pane 數不變；ordering regression 在 dispatcher callback 前已讀到 graph | 否 |
| `/quit` 會關閉 pane 或留下 Ari child process | `process-info` 回到原 `zsh` PID `89235`，`pB` 仍存在且可再次輸入 `Ari` | 否 |

## v0.3.1 歷史 tab 入口 gate

2026-07-31 重新 link local plugin 後，Herdr plugin receipt 讀回：

- 使用者可見名稱：`Ari`
- plugin version：`0.3.1`
- 相容 plugin ID：`ai-coding-mate`
- 一般主 pane：只有 `mate`
- 輔助 pane：`context-branch`，只能由 selection action 使用
- 主 pane command：`bun bin/aicoding-mate pane`

真實 Herdr surface：

- `aicoding-mate open --mode standard --placement tab` exit 0。
- Herdr 回報 entrypoint `mate`、最終 pane `w1N:pA`、label `Ari`。
- `herdr pane read w1N:pA` 讀回 `目前模式：standard` 與互動 prompt。
- 輸入 `/help` 後讀回五個模式與四個控制指令。
- 輸入 `/expert` 後 prompt 由 `[standard]` 變成 `[expert]`。
- 輸入 `/status` 後讀回 `mode=expert completed_turns=0 context_turns=0`。
- 輸入未知 `/wat` 後讀回明確錯誤，模式仍為 Expert，沒有派工。
- `process-info` 只有 `bun bin/aicoding-mate pane`，證明改名沒有另起 worker，也沒有改寫技術入口。
- 驗收結束前以 `/standard` 還原預設模式；最終 `/status` 為 `mode=standard completed_turns=0 context_turns=0`，pane 保持開啟並聚焦。

Automated gate：

- `bun test`：183 pass、0 fail、853 assertions。
- `bun run typecheck`：exit 0。
- CLI argv boundary test 證明 `open --mode expert` 呼叫 Herdr `--entrypoint mate` 並傳入 `ACM_INITIAL_MODE=expert`。
- console state tests 覆蓋 inline slash task、Learn progressive disclosure、最近四輪 context 上限、結構化 `ui_continuity_only` metadata 與輸出摘要。
- dispatch regression 直接截取第二輪 payload，證明前輪 request 只在 `continuityContext`，不在 worker 收到的 `currentTask`。
- routing regression 直接呼叫真實 `dispatchMateTask`，證明 Quick／Standard／Expert→Adversarial／Research／Learn→Standard 的對應。
- scope regression 證明本輪危險 request 仍會被 Quick／Standard gate 阻擋；歷史內容不再靠 lexical 例外略過，而是根本不進入 worker task。
- non-TTY multi-line session、保留 marker 拒絕與 per-turn dispatcher exception recovery 都有 CLI regression。

本次增量 gate 沒有為了測試入口而觸發新的付費模型任務。它證明 unified pane、slash controls 與 Herdr wiring；Standard／Adversarial／Research 的 workflow runtime evidence 邊界仍以下列 v0.2 記錄為準。

### v0.3 review gate

- standards review：GO，無剩餘 P0／P1／P2。
- authority/spec review：初次指出歷史 context 仍會進入 worker；改成結構化 `currentTask`／`continuityContext` 且只 dispatch 前者後，re-review GO。
- Claude Fable review：初次指出 mode→workflow routing 缺少真實 dispatcher regression；補測並移除舊 `*-pane` 入口後，新對話 re-review 回覆 `GO`。

### v0.3 debugging hypotheses

| 假設 | runtime 證據 | 判定 |
| --- | --- | --- |
| `open --mode expert` 仍會開舊 Adversarial pane | CLI argv regression 與 Herdr open receipt 都顯示 entrypoint `mate`；manifest 無 Adversarial pane | 否 |
| 只輸入 `/expert` 會暗中派出模型 | 切換後 `/status` 為 `completed_turns=0 context_turns=0`；`process-info` 只有 `bun bin/aicoding-mate pane` | 否 |
| 未知 `/wat` 會重設模式或落入一般任務派工 | `/wat` 前後兩次 `/status` 都是 Expert、0 completed、0 context；畫面只回報未知指令 | 否 |

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
