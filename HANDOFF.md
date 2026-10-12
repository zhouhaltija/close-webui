# CloseWebUI 交接记录 · 2026-10-12 晚间

本文件按用户最新要求撰写，并与当前工作区一起保存为 **WIP 提交**。本轮起点为 `c4f27c1`；交接提交的哈希请运行 `git log -1 --oneline` 查看。用户要求换电脑后继续，因此停止进一步实施和长时间验收，不归档 OpenSpec。本次只提交到本地，未推送；换电脑前需要另行同步这个提交。

## 接续入口与进度

- 先读 `AGENTS.md`，再读 `openspec/changes/fix-provider-setup-and-chat-experience/` 下 proposal、三份 specs、design、tasks。
- 当前修复变更 **7/19**。本轮只新勾选 4.1（设置页三宽度视觉与可达性）；其余项即使有代码，也没有根据局部通过提前勾选。
- `build-multi-provider-backend` 的 17/17 是原基线交付记录，不是本修复验收结果。
- `build-chat-frontend` 仍为 32/33；真实设备中文输入法与手机软键盘验收没有完成。
- tasks.md 保留了公司电脑下午的历史记录；**以下晚间记录与本文件是最新接续依据**，不要再次修复已经解决的问题，也不要沿用历史全绿声明。

## 本轮已保存的实现

1. **发现元数据并发**：`rememberDiscovery` 以发布锁覆盖 COMMIT 返回和缓存发布，防止较早事务延迟发布覆盖新缓存。创建或 PATCH 改绑供应商/原始型号属于 `newBinding`，在供应商行锁内重新核验最新发现。原身份更新采用数据库最新元数据。配置指纹变化、过期或无法确认的截断缓存返回明确错误。
2. **2048 项容量边界**：按原始 ID 重新发现时优先缓存目标候选，缓存仍有界；完整发现中的明确缺席以 nil 元数据占位表示。超过容量的未知候选仍能单建/批量保存可信能力；已知型号也遵守上游更低上限。新增回归覆盖第 2049/2050 项与 PATCH 旧能力竞态。
3. **流式背压记账**：消费字节改为 atomic 累计，单槽通道只合并唤醒，避免旧 128 槽通知满时丢账、空队列仍被判定占满。持久化完成后再发正文的契约不变。
4. **前端提交状态与对账**：创建对话后保持 submitting，生成响应接受后才 awaiting。明确 4xx（408 除外）拒绝回退提交前缓存，移除未保存消息对；网络/5xx/408 按原消息与 generation ID 对账，必要时停止原生成并再次读取。无法确认时保留未决屏障及“核对提交状态”，禁止普通重发。协调器按 QueryClient、身份版本和模式保留，跨设置页往返不会丢屏障；停止、删除、退出和身份变化拒绝迟到结果。只清本次已发送值，保留后来输入的草稿。
5. **高亮缓存**：语言与正文为键，复用进行中 Promise/完成 HTML；LRU 最多 64 项、约 4MiB 字符串预算，失败清除并允许重试。正常产品没有 profiling 钩子。
6. **测试夹具与运行时间**：修正 Anthropic 仿真内容块序列与正文；旧生成夹具正确处理发现 GET，消除 panic；迁移测试验证单次 Down 只回滚元数据、保留账号，再重应用及完整回滚。夹具初始化有 90 秒超时，`server:test` 套件改为 25 分钟以容纳远端数据库往返。

## 最新验证及明确边界

| 检查 | 本轮实际结果 | 可据此声明的范围 |
| --- | --- | --- |
| 前端完整 Vitest | **15 文件、168/168**，20:26:24 启动，exit 0 | 包含最新设置往返未决屏障、退出隔离、草稿、迟到对账与高亮回归 |
| typecheck / 完整 lint | 同轮及交接提交前均 exit 0，新增 profiling 配置/脚本也经 lint | 不等同于 E2E 或 profiling 构建成功 |
| Go 完整功能 suite | `.cache/go-final.log` exit 0，app 650.129s、migrate 15.501s、security/upstream 通过 | 该次编译早于最终 PATCH 改绑及消费记账补充，**不能称最新全部 Go 改动已全量通过** |
| Go 最终定向回归 | 两并发、完整容量/改绑、三项 credit 回归通过，app 49.150s | 最新改绑和记账代码有定向绿灯；credit 三项另连续 100 次通过 |
| Mock / 浏览器仿真接口 E2E | **36/36**（先前版本） | 本轮后续提交对账、新 E2E 和性能测试修改尚未完整重跑 |
| sqlc | 1.30.0 重新生成，生成代码无文本 diff | 生成文件曾因行尾显示 modified；提交应无业务差异 |
| 编译 / vet / 严格验证 | 交接提交前 `go test ./... -run '^$'`、`go vet ./...`、三份 OpenSpec 严格验证及 `git diff --check` 均 exit 0 | 编译检查未执行 Go 测试；最新完整 Mock/real/server build、Go suite/E2E 仍需补齐 |
| race / 实网 / 实机输入 | 未完成 | 无 GCC/cgo 条件；无有效实网密钥；不以仿真或 DOM 事件替代实机 |

首轮 Go 在默认 10 分钟超时；随后 25 分钟套件通过。超时可能遗留不可归属的随机测试 schema，**不要批量删除**。本轮未改持久手动测试 schema，也未重启 `127.0.0.1:18080`。暂停检查未发现 4173/4174/4175/18080 监听进程。

## 性能实测：当前仍不达标

`generations_stage_perf_test.go` 对四协议各 **1 次预热 +30 次**，每 50ms 输出、42 个标识片段、超过 20k 字符、代码/表格、0/500/2000ms 首字延迟。测量的是原生完整正文行读取 → 真实 PostgreSQL 持久化完成 → 实际 Flush 返回，全部走本地仿真上游和独立随机 schema。

| 协议 | 正文→Flush p50 / p95 ms | 持久化 p95 ms | SELECT 1 p95 ms | 本次目标 ms |
| --- | --- | --- | --- | --- |
| OpenAI Chat | 210.33 / **373.29** | 205.05 | 215.05 | 305.05 |
| OpenAI Responses | 205.74 / **343.17** | 163.55 | 160.00 | 263.55 |
| Gemini | 203.65 / **332.43** | 148.31 | 118.04 | 248.31 |
| Anthropic | 194.37 / **363.97** | 138.57 | 110.72 | 238.57 |

全部超过“持久化 p95 +100ms”。采样命令 **exit 1**，不能宣称性能目标达成。测得每增量批次底层 `net.Conn.Write` 计数为 1，不能称作数据包计数。数据提示较高数据库往返和单写入期间的积累/下一批等待需要分析，尚未完成根因量化或进一步优化；不要仅归因数据库，也不要降低目标、换成假存储、提前发送未保存正文来过测试。

原始 JSON 在忽略的 `test-results/performance-go-current-*.json`，日志在 `.cache/performance-current.log`，**不会随 Git 换机**。上述汇总保存在本文件；需要原始样本时安全拷贝这些合成数据文件，或重新串行采样。现有 `test-results/performance-browser.json` 是 **10 月 11 日旧结果**，不得用它证明本轮浏览器性能。

## 刚准备、尚未运行的性能工具

- `scripts/performance.mjs`：加载本地服务端环境，优先缓存 Go、回退系统 Go，执行 opt-in 采样并写忽略日志。`node scripts/performance.mjs current` 已有本轮同等入口实测；新保存的便携入口还需核验。不要与 Go suite/E2E 同时执行。
- `29483aa` 的真实仓库快照曾 `git archive` 导出至 `.cache/performance-baseline`，复制同一 `generations_stage_perf_test.go` 后编译通过，**尚未运行旧 Go 性能采样**。新机器需重新导出，并复制同一测试文件；不切换当前 HEAD，不用合成旧实现替代。导出目录不带 `.env.backend.local`，入口通过子进程环境提供原数据库配置。
- `tests/e2e/performance.spec.ts` 已改为接收增量 → DOM/layout → 下一 rAF，每样本先生成已完成旧回答；逐片段标识、释放 observer/恢复 fetch，输出 JSON。不能把事件间隔或 DOM 变化次数称为纯 React render 时间/次数。
- `cmd/testserver` 增加仅测试用 `/__test/performance?sample=<UUID>`，有界保留 64 个虚构样本的标识与发送 epoch 时间，不保存正文/密钥。浏览器同本机 epoch 时间关联上游→DOM 的新增路径 **尚未运行**。
- `tests/performance/vite.profile.config.ts` 原在忽略目录，现为换机保存到仓库。它只在单独构建中 AST 注入 React.Profiler 与 MessageView 执行计数，并 alias `react-dom/client` → profiling。**尚未构建或浏览器验证**；Vite alias、profiling 实际是否生效和基线根目录解析需验证。普通 Vite 构建不调用该配置。

当前 profiling 准备命令（仓库根，输出独立目录，不覆盖用户站点）：

```powershell
$env:VITE_ENABLE_MOCK = 'false'
$env:VITE_API_BASE_URL = '/api'
node node_modules/vite/bin/vite.js build --config tests/performance/vite.profile.config.ts --outDir .test-dist/profile-current
Remove-Item Env:VITE_ENABLE_MOCK, Env:VITE_API_BASE_URL
```

另需配置测试服务 `-static` 指向该目录、专用 Playwright 配置仅运行 backend 性能测试，并设置 `PROFILE_IMPLEMENTATION=current`。原前端设 `PROFILE_ROOT` 指向导出的真实基线、`PROFILE_IMPLEMENTATION=29483aa`，使用同一后端作受控前端比较，明确 profiling 开销；实际旧 Go 的比较由独立 stage harness 完成。**这些启动与比较配置尚未准备/运行完成，不要直接声称工具已验收。**

## 明天建议执行顺序

1. 同步本次 WIP 提交，检查 `git log -1`、`git status`；读取本文件及最新 tasks，不继续下午已解决的旧待办。
2. 安装/确认 Node 24、pnpm 11.23.0、Go 1.27+、sqlc 1.30.0、Chrome/Playwright。运行 `pnpm install --frozen-lockfile`。若全局 pnpm 因版本联网检查卡住，验证阶段可按现有记录用 `node node_modules/...` 调用同一工具，不更换依赖管理器。
3. **先复审尚未最终审核的设置往返协调器保留，以及最后新增的 profiling/epoch 关联测试工具。** 独立审查此前提出的容量、改绑、丢 credit、幽灵消息、非终态对账均已修复并有回归；最后设置往返修复有 168/168 证据，但尚未再独立复审。
4. 完整运行 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm server:test`、`pnpm server:vet`、sqlc generate/diff、Mock/真实前端和服务构建、完整 `pnpm test:e2e` 与三个变更严格验证。数据库 suite、E2E、性能测试串行独占。最后的响应性 E2E 已调整为拒绝不留未保存消息，并新增未知结果需核对的测试，尚待运行。
5. 重跑当前/旧真实 Go 性能与当前/旧前端生产及 profiling 采样，分析原始样本和等待阶段。1.2、5.3、6.3、7.1、7.2 尚不能关闭；其他项逐条核对证据再勾选，不能以代码存在代替验收。
6. 验收后再向既有持久手动测试 schema 应用新迁移、构建真实服务并启动 18080 检查。当前 `.env.backend.local` 的 DSN 未显式指定 search_path；**不要直接拿默认 DSN 当作该手动 schema 迁移入口**。先核验 schema 归属与 `current_schema()`，保留数据。

## 换电脑必须另行安全迁移的东西

- 忽略的 `.env.backend.local` 及**原加密主密钥**；不要重新生成主密钥，否则旧供应商密钥无法解密。秘密不能放 `VITE_`、交接文档或 Git。
- Go/sqlc 缓存、node_modules、构建产物、截图、报告和日志不进 Git，可重新安装/生成；需要保留本轮原始性能样本时另拷上述合成数据文件。
- 持久手动测试 schema 为 `closewebui_manual_d110c8b259674c09a476bd22984de6fe`，保留原数据；严禁测试回滚 public 或清理无法安全归属的 schema。
- 当前本地提交不会自动出现在另一台电脑。未授权推送；需用户另行推送或用 Git bundle 等方式传递提交。
