# Tasks

2026-10-13 用户已确认正文发送与数据库保存并行、完成前全部保存、刷新仅恢复已保存部分。新策略代码已实施，完整验收尚未通过，当前为 9/19；以下最新实施记录优先于历史证据。历史记录保持当时的保存后发送语义，不能替代新策略验收。

## 1. 复现与基线

- [x] 1.1 在基线 29483aa 补六问题的针对性回归，确认真实菜单、整行坐标点击、供应商上下文、能力回退和慢提交测试的红灯原因，保留日志而不提交私人截图。
- [ ] 1.2 建立至少 30 次仿真性能采样和分阶段计时，交付原实现 p50/p95、数据库往返、长回答渲染与 SQL 往返数量；按片段标识或正文偏移分别关联发送和保存，保留原基线的保存后发送语义，验证测试不调用付费模型或记录秘密。

## 2. 模型与账号菜单

- [x] 2.1 恢复真实模型 Dropdown 与原生思考子菜单，DOM/浏览器验证草稿、勾选、切换默认、预算/开关、未知能力、鼠标跨菜单和 Escape；截图对齐原 model-effort-menu 交互。
- [x] 2.2 修正账号菜单整行命中区域，浏览器分别点击行左、中、右及内边距验证设置跳转，覆盖键盘与移动端，验证分隔线/外侧不误退出。

## 3. 目录与发现契约

- [x] 3.1 建立与现有注册表一致的版本化可枚举目录，验证七家族代表条目、准确 provider aliases、默认行为、日期和文档来源，覆盖截图硅基流动 GLM 型号及相似但未核实的 ID。
- [x] 3.2 保留并规范化明确支持的上游模型元数据，四协议契约测试验证输出限值、缺失字段、冲突交集、原 ID 不改写和未知能力不猜测。
- [ ] 3.3 实现 model-candidates/model-catalog 及来源回退，httptest/数据库测试验证成功、空列表、401/403、超时、非法响应、内置无项、缓存失效及跨用户 404；更新接口说明，原 discover 数组契约仍通过。
- [ ] 3.4 实现统一校验的批量模型添加与自动默认值，数据库测试验证准确归属、去重、逐项失败、已有用户覆盖不被改写；本轮为服务端能力元数据追加 goose 迁移并重新生成 sqlc，不修改已执行迁移，旧模型默认值及历史保留。

## 4. 供应商工作区

- [x] 4.1 实现 Claude 风格分类/供应商列表/分组详情与紧凑模型行，参考 LobeHub 搜索/配置交互；1440/1024/390px 截图验证易读、关键操作可见与移动逐级导航，无横向溢出。
- [ ] 4.2 接通供应商路由与内联保存、首次自动发现和刷新，DOM/E2E 验证未保存编辑、密钥保留、停用、删除、无配置和错误状态，A 切 B 后迟到响应不会覆盖 B。
- [ ] 4.3 接通候选批量添加、原生参数、启停与默认模型，全局模型可进入同一配置入口；始终展示当前回复上限/可信最大输出/思考支持与默认设置，验证添加后刷新保留元数据及用户覆盖、默认删除不替换、身份不泄露。

## 5. 即时反馈与增量展示

- [x] 5.1 将提交预览与已保存消息分离，慢 create/generate 各两秒的 DOM/浏览器测试验证点击后 100ms 内显示消息、无空欢迎页、成功按 ID 合并且草稿不重复。
- [x] 5.2 减少冗余 GET 并实现失败/不确定提交对账，回归验证输入恢复不覆盖新草稿、服务端仍校验最新历史、首字前停止与断连不重复提交或复活导航；验证较短数据库快照不截断活动实时正文，保存失败明确提示、刷新仅恢复已保存部分且不自动重发；记录状态机。
- [ ] 5.3 实现受控帧合并、稳定消息引用和高亮缓存，验证已完成消息渲染次数、20k 字符代码/表格性能、复制与 Markdown 正确；停止/删除/退出取消待绘制任务。

## 6. 流式持久化

- [x] 6.1 将增量保存减少到单次原子数据库操作，数据库测试验证归属、影响行数、活动 ID 条件、单请求锁和并发停止/删除/重试；交付 SQL 往返数量前后对比。
- [ ] 6.2 实现正文发送与保存并行、有界积累及顺序单写入，先补四协议慢写红灯并验证首段在保存完成前可见；覆盖每 50ms 高频片段、计入正在写入字节的容量/背压、EOF 与上游错误排空、停止/断连/删除竞态、正文及终态保存失败。仅全部正文和 completed 终态已保存才发送 done，保存失败明确提示且不发 done，迟到批次不改变终态。
- [ ] 6.3 按 design 固定场景复测至少 30 次，分别交付正文到 Flush、正文到保存、到浏览器展示、增量渲染及最终保存等待的 p50/p95，与真实 Git 基线比较；满足 100ms 预览、未饱和场景正文到 Flush p95 100ms、32ms 渲染指标，报告全部背压样本、队列峰值和显示/保存进度差，不将旧性能失败或数据库保存延迟混作新显示指标。

## 7. 集成与审查交接

- [ ] 7.1 运行 go test/vet、sqlc diff、前端 typecheck/lint/test/test:e2e/build、OpenSpec 严格验证；完整回归两用户、四协议、停止、重启、删除、重试、Mock 模式及并行保存的完成/失败/恢复语义，保存最新证据并恢复真实构建。
- [ ] 7.2 提供六项问题逐一对应的修复证据、三宽度截图、菜单坐标与键盘结果、性能原始样本和测试命令，说明保存后发送到并行保存的语义变化与未保存尾段恢复限制，更新验收记录/开发约定而不抹去原实机输入法未验收记录；交原协作者独立审核。

## Workflow follow-up

- 此变更已部分实施；实施者按最新验收证据与 OpenSpec apply 进度推进，不根据历史交接或旧基线通过自动勾选。
- 用户另行授权后才提交或推送修复、归档变更或调用真实付费模型。
- 真实设备中文输入法与手机软键盘仍需要人工验收，不以自动化代替。

## 实施证据与未勾选项

### 2026-10-13 规划修订（实施前记录）

- 已获用户确认：正文增量发送与香港数据库保存并行；保存有界、合并且保持顺序；全部正文和终态保存成功才完成；保存失败明确提示；刷新或服务崩溃只恢复已保存部分，显示尾段可能丢失。
- 规划修订时只修改 proposal、chat-responsiveness spec、design 和 tasks，未修改产品代码或勾选实施任务；随后实施情况见下一节。
- 下列 2026-10-12 记录及 `HANDOFF.md` 是历史实现/验收依据，其中保存后发送保证和“持久化 p95 +100ms”目标已由本次规划替代；保留历史失败原值，不能据此宣称新策略已验收。其他缺陷修复证据与原实机输入法未验收记录继续有效。

### 2026-10-13 并行策略实施与验收记录

用户质疑长时间无可见进展后，不再追加长测试。最后一次 Chat/Gemini 性能命令已自行结束，exit 0；本记录不表示完整交付或全套验收通过，不提交、推送或归档。

- 后端已拆分发送与顺序保存：正文进入有界队列后立即发送，额度覆盖排队、合并及正在写入的字节；大片段按 UTF-8 边界切块。全部正文与 completed 终态保存成功才发 done；正文/终态保存失败发 SAVE_FAILED。收尾排空期限 10 秒，停止、删除及取消拒绝迟到写入/终态事件。
- 前端已保护活动正文免受较短 GET 快照截断；SAVE_FAILED 的显示尾段按对话保留，恢复先按原 generation ID 停止再读权威内容；取消、删除、退出拒绝旧恢复结果。查询错误时仍提供保留正文、复制及恢复入口。
- 定向数据库回归已取得四协议阻塞写入时正文先显示、done 等保存、终态失败、UTF-8/容量、600 片段合并为 20 次写入、8MiB 限制、停止/删除/重试、断连、EOF 排空取消及 failed 终态期间取消的通过证据。两处旧“delta 即已保存”断言已修订；不以定向结果替代全套。
- 最新前端完整测试为 15 文件、181/181 通过，typecheck、lint、Mock build、Go vet、sqlc 重新生成无文本差异及三份 OpenSpec 严格验证均取得 exit 0。profiling 构建成功，但未跑浏览器 profiling；未执行最终 server:build，当前 dist 为 Mock。
- 完整 Go 测试未通过：`.cache/go-parallel-full.log` 中 app 达 25 分钟套件超时，migrate 失败；同时出现数据库连接/初始化/清理失败及后来修复的旧断言。定向组 `.cache/go-parallel-regression.log` 亦未全绿。不能笼统归因于环境，也不能宣称后端完整通过。
- 完整 E2E `.cache/e2e-parallel-full.log` 为 44 通过、6 失败、1 性能采样跳过；Mock 与浏览器网络仿真实接口 37 项全部通过。真 Go 模式包含数据库/账号加载故障和旧定位器失败；定位器已修，六项重跑因 schema 迁移失败未启动，未取得通过证据。首轮产物保留于 `.cache/e2e-parallel-initial-results/`。

四协议分别预热 1 次并采样 30 次，使用本地仿真上游及真实香港 PostgreSQL；成功样本均校验数据库完整正文一致、completed 保存先于 done。原始样本位于忽略目录 `test-results/performance-parallel-v2/performance-go-current-<protocol>.json`。

| 协议 | 服务端有效正文到 Flush p95 | 单次保存 p95 |
| --- | ---: | ---: |
| OpenAI Chat | 1.03ms | 3310.68ms |
| OpenAI Responses | 1.04ms | 1282.47ms |
| Gemini | 1.01ms | 552.29ms |
| Anthropic | 1.03ms | 262.22ms |

这些数值只证明当前固定采样场景的发送与保存解耦，不是点击到首字、浏览器 DOM 或纯 React 渲染耗时。首轮四协议性能命令未全绿；Responses 重跑 267.974 秒、Chat/Gemini 重跑 622.949 秒 exit 0，Anthropic 首轮完整采样成功。实际 Git 旧基线仅导出及编译，未完成同条件采样；浏览器 30 次采样与纯渲染指标未运行，不声明前后改善比例，不勾选 1.2/6.3。

独立代码审查后的额外只读核查确认一个恢复缺口：生成中刷新，新页面可能先读取 pending/streaming 前缀；旧请求随后保存 stopped 后，详情缓存没有重取，可能持续显示正在生成。在本节记录时尚未修复，5.2/6.2/7.1 保持未勾选；随后用户要求继续，修复和最新验收见下一节。

真实设备输入法/软键盘、实网付费供应商、race、最终真实构建及完整 Go/E2E 均仍未验收。部分随机测试 schema 清理失败，不能安全归属的 schema 不删除；持久手动 schema、18080 站点及秘密配置未修改。

### 2026-10-13 接续修复刷新恢复

- 用户要求继续后，修复真实模式详情缓存：本页面无实时正文且服务端回答非终态时每 2 秒只读重取，终态后停止；读取失败显示重试，绝不因为缺少本地 active 自动 POST stop。新增两项 DOM 回归先实际失败（只 GET 一次），修复后通过；浏览器生产预览的刷新回归也通过。
- 修复终态保存持续失败后的孤立状态：job 在 begin 前登记、全部排空/收尾后才移除；GET 仅对活动表中不存在的生成调用带身份和 generation 围栏的 finish(stopped)，保留数据库正文和元数据，再重读。运行中的及已取消仍排空的 job 不由 GET 终结。`TestConversationReadRecoversOnlyOrphanedGeneration` 先实际失败，修复后 34.79 秒通过，并验证恢复后迟到 append 被拒绝。
- 独立只读审查本轮刷新恢复及相邻生命周期，没有 Critical/Important 问题；不将此审查扩大为既有性能基线和全套验收通过。
- 完整前端测试 15 文件、183/183 通过。随后类型检查发现新增测试夹具漏填必需 retry 字段，补全后 typecheck/lint 通过。安全/四协议 upstream 包完整测试、无数据库的配置与额度回归、Go vet 通过。3.2 的四协议元数据契约验收完成并勾选，CLI 进度 8/19。
- `pnpm server:build` 通过，浏览器验收后再次执行并通过，最终 dist 已恢复为真实模式，服务二进制位于忽略的 `.cache/bin/`；没有启动或部署持久手动站点。
- 完整浏览器回归使用 Chrome、1 worker、max-failures=1：39 通过、1 失败、12 未运行，5.1 分钟。38 项 Mock/网络仿真实接口（包括新刷新回归）全部通过；真实 Go 注册/原生思考配置/保存/重试/停止/两用户隔离通过。1440px 设置测试在自动发现 20 秒后仍“拉取中”而失败，故停止后续项；不能宣称完整 E2E 全绿。
- 失败 trace 中 GET providers 用时 12.82 秒，随后模型、偏好、历史与 model-candidates 多个请求未完成；随后独立迁移回归在连接数据库时 context deadline exceeded，31.58 秒失败（`.cache/go-resume-migrate.log`）。这提供数据库连接链路故障证据，不证明所有历史失败都源于环境；不改真实数据库配置，不放宽断言或据此勾选完整回归。
- 5.2 的前端协调/快照/失败恢复/未决屏障回归、慢提交/停止/刷新浏览器回归及孤立状态真实数据库回归已通过，服务端 begin 仍在锁定对话的事务内读取并校验最新历史；状态机和恢复规则见 design，因此勾选 5.2，CLI 最终进度 9/19。完整流式持久化和全量回归任务仍不勾选。
- 单独重跑四协议门控并行回归（`-v -failfast -timeout=4m`）在首个 OpenAI Chat 子项收到 SAVE_FAILED 后失败，独立 schema 清理也超时，124.41 秒；其他三协议本次未执行，日志 `.cache/go-resume-parallel-four-protocols.log`。该结果不能替换上一轮四协议有效性能样本，也不表示本次四协议全绿。测试 helper 发现收到错误终结后还等 90 秒成功超时，已改为在不符合预期的终态或 EOF 时提前失败；最新全包 compile-only 与 Go vet 通过，仅编译不替代数据库测试。本轮不再重复连接故障下的长回归。

本轮未追加 30 次浏览器/profiling/旧 Git 基线性能采样，旧四协议服务端性能仅代表上一轮固定场景，不能替代这些指标。完整 Go/E2E、实机输入、实网及 race 仍未完成；后续定向数据库结果须单独记录，不覆盖上述失败。

### 2026-10-13 用户要求运行真实演示

用户要求“运行一下给我看看”后，已只读核验既有 `closewebui_manual_d110c8b259674c09a476bd22984de6fe` 的 current_schema 和所有权，确认迁移版本 1、缺少 discovery_metadata 字段；随后在该 schema 执行追加版本 2 迁移，保留数据，不触碰 public，不修改 `.env.backend.local` 或主密钥。使用最终真实构建启动 `http://127.0.0.1:18080/`，HTTP 首页 200、未登录鉴权接口 401、仅监听 127.0.0.1 均已检查。浏览器预览打开请求已提交。启动辅助脚本、PID 及日志仅存忽略的 `.cache/manual-preview/`；启动不代表完整验收或实网模型调用通过，未 Git 提交、推送或归档。

### 2026-10-13 关闭演示并提交工作区

用户随后明确要求关闭网站并提交工作区修改。已核对记录的 PID 对应本仓库预览二进制后停止该进程，并确认 18080 不再监听；保留手动 schema 和现有数据。本次 Git 提交保存当前实施与验收证据，进度仍为 9/19，不代表完整 Go/E2E、浏览器性能或实网验收通过；不推送、不归档。本地环境文件、主密钥、构建产物、启动辅助脚本、日志与截图均不纳入提交。

以下为前一实施轮记录，不能替代当前验收。2026-10-12 独立审查后按真实证据重新打开未完整满足的任务；本轮用户授权修复十个浏览器失败，逐项以最新验证更新勾选，尚待验证上游元数据、缓存失效及完整性能指标。

| 任务 | 证据 |
| --- | --- |
| 1.1 | 六项修复均先写复现测试并观察到红灯：`RealModelSelector.test.tsx`（原 Dialog → 断言 `queryByRole('dialog')` 为 null 失败）、`generation.test.ts` 新增 8 项（预览/对账/帧合并在旧实现下失败）、`Composer.test.tsx`（发送与停止按钮为同一元素）、`styles.css` 的整行命中由 E2E 坐标点击覆盖。 |
| 1.2 | `tests/e2e/performance.spec.ts`：1 次预热 + 30 次采样，`[perf]` 固定 50ms、20k 字符、代码块与表格；原始样本写入 `test-results/performance-browser.json`。SQL 往返对比由 `TestAppendDeltaUsesOneAtomicStatementPerBatch` 用计数 `net.Conn` 实测（旧 4 次 vs 新 1 次）。 |
| 2.1 | `src/components/RealModelSelector.test.tsx` 9 项 + E2E `the composer model menu is an anchored dropdown…`（断言 `.model-menu` 与触发框底对齐、无 overlay、无 dialog、Escape 后焦点回触发器等）+ `test-results/screenshots/fix-model-menu-1440.png`。 |
| 2.2 | E2E `the account menu row is clickable across its whole width`：对设置行左缘/中点/右缘/内边距四个真实坐标点击均进入 `/settings/providers`；分隔线外侧与菜单外点击不触发退出。 |
| 3.1–3.2 | `server/internal/upstream/catalog_test.go` 9 项（47 条目录、能力与注册表 `reflect.DeepEqual` 一致、`zai-org/GLM-5.3-Flash` 精确匹配且小写/去前缀/加 `Pro/`/换 adapter 均不匹配、mandatory 与 efforts 与预算边界、Notes 与双来源 URL、VerifiedDate）。 |
| 3.3–3.4 | `server/internal/app/model_discovery_test.go` 13 项（httptest + 独立随机 schema）：上游成功、空列表回落、401/403/超时/非法响应/内置无项、跨用户 404、批量 added/exists/failed、去重不改写用户覆盖、0/101 项上限、旧 `discover` 数组契约回归。 |
| 4.1–4.3 | `src/components/Settings.test.tsx` 19 项 + E2E `the provider workspace keeps its panes reachable at {1440,1024,390}px`（截图 `fix-provider-workspace-*.png`、无横向溢出、390px 逐级切换与返回入口）。 |
| 5.1–5.3 | `src/core/generation.test.ts` 14 项（预览 100ms、ID 合并、对账、停止不复活、`load` 复用缓存、消息引用稳定、`updatedAt` 不随增量跳动）+ E2E `responsiveness.spec.ts` 3 项（慢 create/generate 各 2s、拒绝恢复草稿、创建前停止）。 |
| 6.1–6.2 | `server/internal/app/generations_perf_test.go` 9 项：单条 CTE 原子 SQL、归属/影响行数/活动 ID、并发停止/删除/重试、单请求锁、四协议仿真、慢库背压（600 片段 → 20 次原子写，峰值并发写 = 1）、EOF、写失败不报成功、8MB 上限。 |
| 6.3 | `test-results/performance-browser.json`：30 次采样，clickToPreview p50=13ms / p95≈17ms（目标 ≤100ms）、oldMessageMutationsTotal=0、longTaskCount=0、welcomeOverlapSamples=0；四协议首段可见延迟 186–238ms（远程库 RTT 75–90ms 实测）。 |
| 7.1 | `node scripts/server.mjs test` exit 0（internal/app 约 380–412s）、`node scripts/server.mjs vet` exit 0、sqlc 未安装，以 `sql/queries.sql` 26 条命名查询与 `internal/db/queries.sql.go` 26 个生成方法逐一对应且 `git diff --stat sql/ internal/db/ migrations/` 为空证明一致、`tsc -b`/`eslint .`/`vitest run`（114/114）/`vite build` exit 0、`openspec validate … --strict` exit 0、`git diff --check` exit 0。 |
| 7.2 | 历史交接文件已按用户要求删除；当前验收证据与未完成项以本文件为准。 |

### 明确未验收（不以自动化代替）

1. **真实设备中文输入法与手机软键盘**：`build-chat-frontend` 的 6.4 历史未勾选项继续有效；自动化只覆盖组合输入 DOM 事件与 Enter/Shift+Enter，不能代替目标设备实机验收。
2. **真实供应商付费调用**：本机无有效密钥，四协议与代表模型均只经过本地仿真上游验证；`zai-org/GLM-5.3-Flash` 的能力参数按官方文档落入注册表，其在硅基流动是否上架、账号是否有权限均未经真实调用核实（目录 `notes` 已声明"候选不代表账号已获权限"）。
3. **`-race` 数据竞争检测未运行**：本机无 gcc（`cgo: C compiler "gcc" not found`）。生产代码仅经通道 + `writeMu` 通信，测试侧 tracer 记录有 happens-before 链，但缺少 race detector 背书。
4. **E2E 端口竞争**：验证期间多个并发进程争用 4173/4174/4175（`reuseExistingServer: false`），曾出现 `http://localhost:4173 is already used` 与 trace 产物 ENOENT 的假失败；最终一次完整 E2E 由单人独占窗口重跑，结果以 `.cache/e2e-full.log` 与 `test-results/` 产物为准。

### 2026-10-12 本轮暂停记录（用户要求停止并提交工作区）

本轮基线为 `042a496`。本次提交保存实施中的工作，不表示本变更已全部验收；不归档、不推送、不重新创建 HANDOFF 或 prompt 文件。

已实现：

- 参考 LobeHub 的搜索、连接配置与模型管理结构，自主实现 Claude 风格暖纸色界面：分类导航、供应商列表、分组连接配置、高级折叠、紧凑模型行；调整桌面和移动端字号及间距。
- 供应商和全局模型页常显“模型设置”入口；全局页通过 `?model=<内部ID>` 进入供应商内同一个行内编辑器。
- 模型行始终区分用户每次回复上限与可信模型最大输出，展示限值来源、上下文和思考状态。已明确不支持与尚未核实状态分开；自动/关闭预算使用语义选项。
- 拉取模型或更新密钥后刷新模型能力，保留用户参数；候选缓存加入身份与供应商连接版本。
- 后端增加服务端白名单发现元数据、连接指纹、有界缓存和 `00002_model_discovery_metadata.sql` 迁移；已重新生成 sqlc。DTO、保存、生成快照与协议请求共用能力合并，正式 Anthropic Models API 可为未知 ID 提供明确的原生控制契约。
- 修复独立审查发现的未知 Anthropic 型号关闭思考时 `thinking.type` 为空的问题；增加关闭请求回归。保存时增加供应商行锁与连接指纹复核。

最新验证证据：

- `node node_modules/vitest/vitest.mjs run`：14 文件、140/140 通过（16:30:51 启动）。注意运行前清除真实构建的 `VITE_ENABLE_MOCK=false`，否则 Mock App 测试会因环境污染失败。
- `node node_modules/typescript/bin/tsc -b` 与完整 `node node_modules/eslint/bin/eslint.js .` 已通过。
- 独立真实构建输出至忽略的 `.test-dist/provider-redesign`；新增 `provider-settings.spec.ts` 的 1440/1024/390px 与不支持思考场景共 4/4 通过。截图已人工查看，确认配置入口、能力摘要、字号与无横向溢出。旧 dist 的两项测试已先出现有效红灯，复现最大输出被遗漏。
- 后端代理报告纯 upstream 测试及 `go vet ./...` 通过；数据库保存/刷新/重启和旧连接拒绝测试已通过。Anthropic 数据库生成/重试测试因远端 PostgreSQL 连接被关闭，尚未通过完整验证。
- 本轮未完成完整 Go suite、完整 E2E、最终 sqlc 无差异复核及所有改动后的 OpenSpec 严格验证。历史通过记录不能替代本轮结果。

下次优先处理：

1. 独立审查发现的两项并发问题仍未完成：新建模型可能保存刷新前的旧元数据；`rememberDiscovery` 在事务提交后发布缓存，两个发现请求可能使缓存发布顺序回退。新增 `TestModelCreateRechecksLatestDiscoveredCeiling` 已实际红灯（`model created against a stale discovered ceiling`），测试留在本次提交，后端套件目前不能声称全绿。需要在创建锁内核验最新发现版本，并保证提交与缓存顺序一致。
2. 重跑 Anthropic 元数据持久化、生成/关闭/重试，以及完整 Go suite；一次 fixture 的随机 schema 清理超时，可能遗留 `closewebui_test_<随机UUID>`，具体名称未输出，不能安全归属或批量删除。检查清理时严禁删除 public 或持久手动测试数据。数据库/E2E独占执行。暂停时所有本轮 Go 测试进程均已结束。
3. 新迁移加入后，现有 `migrate_test` 只执行一次 Down 却期待移除 users，与仅回滚最新版本的行为冲突，尚未调整验证。完成接口文档与独立复审、完整 typecheck/lint/test/E2E/build、sqlc diff、OpenSpec 严格验证；只按实际证据勾选任务。
4. 本轮迁移尚未应用到持久手动测试 schema，测试站点 `127.0.0.1:18080` 本轮未重新启动。验收后迁移原 schema、构建真实前端和服务并打开实际网站检查。

换电脑注意：`.env.backend.local`、加密主密钥、Go/sqlc 缓存、node_modules、构建产物、截图与本地日志均不进入 Git；另行安全迁移原配置与加密主密钥，不能重新生成主密钥，否则旧供应商密钥无法解密。持久手动测试 schema 为 `closewebui_manual_d110c8b259674c09a476bd22984de6fe`，保留数据。新机器安装依赖和 Go 1.27+ 后按 AGENTS.md 命令继续。

### 2026-10-12 接续实施证据

本节及根目录 `HANDOFF.md` 是晚间最新接续依据。用户本次明确要求撰写交接文档并提交当前工作区，覆盖下午“不重新创建 HANDOFF”的旧暂停约定。变更仍为进行中，不归档、不推送。

- 4.1：使用本机 Chrome 运行 Mock 与浏览器网络仿真真实接口模式 E2E，36/36 通过（完整 Go 模式另行验证）。`provider-settings.spec.ts` 在 1440/1024/390px 验证供应商与全局模型的配置入口、回复上限/模型最大输出和原生思考编辑、移动逐级导航及无横向溢出；最新 `provider-settings-*.png` 与 `model-settings-*.png` 已查看。截图仅使用虚构账号与模型数据，位于忽略的 `test-results/screenshots/`。
- 并发缺陷的红灯已复现：`TestModelCreateRechecksLatestDiscoveredCeiling` 保存过时限值；新增 `TestConcurrentDiscoveriesPublishCacheInCommitOrder` 实测数据库最新 8192 而缓存回退到 16000。修复后两测试，以及元数据刷新/重启、旧连接拒绝的定向验证通过。独立审查随后发现缓存容量边界，继续补测；本段不代表最终全量验证。
- 前端初始接续验证：14 文件、140/140 Vitest、typecheck、lint、Mock 构建通过；Go vet 通过；sqlc 1.30.0 重新生成后生成代码无文本差异；三份 OpenSpec 变更严格验证通过。后续改动需要重新验证。
- 晚间最新前端完整验证为 15 文件、168/168（20:26:24 启动）、typecheck/lint exit 0，包含设置页往返未决屏障、原 ID 对账、拒绝后重发、保留新草稿及高亮缓存。Go 功能全量在本轮某次编译通过（app 650.129s）；最后改绑/credit 补充的定向回归通过，但最新全部 Go 差异和完整 E2E 尚待最终重跑。
- 最新容量保护包括创建及 PATCH 改绑；消费 credit 改为 atomic 累积且合并唤醒。独立审查最后提出的设置往返屏障已由 DOM 红绿修复，但未再次独立复审。
- 当前四协议各预热 1 次 +30 次的真实数据库性能采样已完成，正文到 Flush p95 分别为 373.29/343.17/332.43/363.97ms，均超过持久化 p95 +100ms，命令 exit 1。不得勾选性能任务或用旧浏览器报告宣称达标。原始样本忽略，汇总、工具状态与后续命令见 `HANDOFF.md`。
- 最新 profiling 配置和同机 epoch 关联路径仅保存准备工作，尚未构建或 E2E 验证；真实基线只完成导出与同测试编译，未开始旧版本实测。持久手动 schema 未迁移，18080 未重启。实机输入、实网和 race 仍未完成。
- 交接提交前快速核验：typecheck、完整 lint、便携性能脚本语法检查、Go 全包 compile-only（`-run '^$'`，未执行测试）、Go vet、三份 OpenSpec 严格验证及 diff 检查均 exit 0；不替代最终完整 Go/E2E 或尚未执行的 profiling 构建。
