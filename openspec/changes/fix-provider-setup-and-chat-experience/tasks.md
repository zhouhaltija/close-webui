# Tasks

## 1. 复现与基线

- [x] 1.1 在基线 29483aa 补六问题的针对性回归，确认真实菜单、整行坐标点击、供应商上下文、能力回退和慢提交测试的红灯原因，保留日志而不提交私人截图。
- [ ] 1.2 建立至少 30 次仿真性能采样和分阶段计时，交付原实现 p50/p95、数据库往返、长回答渲染与 SQL 往返数量，验证测试不调用付费模型或记录秘密。

## 2. 模型与账号菜单

- [x] 2.1 恢复真实模型 Dropdown 与原生思考子菜单，DOM/浏览器验证草稿、勾选、切换默认、预算/开关、未知能力、鼠标跨菜单和 Escape；截图对齐原 model-effort-menu 交互。
- [x] 2.2 修正账号菜单整行命中区域，浏览器分别点击行左、中、右及内边距验证设置跳转，覆盖键盘与移动端，验证分隔线/外侧不误退出。

## 3. 目录与发现契约

- [x] 3.1 建立与现有注册表一致的版本化可枚举目录，验证七家族代表条目、准确 provider aliases、默认行为、日期和文档来源，覆盖截图硅基流动 GLM 型号及相似但未核实的 ID。
- [ ] 3.2 保留并规范化明确支持的上游模型元数据，四协议契约测试验证输出限值、缺失字段、冲突交集、原 ID 不改写和未知能力不猜测。
- [ ] 3.3 实现 model-candidates/model-catalog 及来源回退，httptest/数据库测试验证成功、空列表、401/403、超时、非法响应、内置无项、缓存失效及跨用户 404；更新接口说明，原 discover 数组契约仍通过。
- [ ] 3.4 实现统一校验的批量模型添加与自动默认值，数据库测试验证准确归属、去重、逐项失败、已有用户覆盖不被改写；本轮为服务端能力元数据追加 goose 迁移并重新生成 sqlc，不修改已执行迁移，旧模型默认值及历史保留。

## 4. 供应商工作区

- [ ] 4.1 实现 Claude 风格分类/供应商列表/分组详情与紧凑模型行，参考 LobeHub 搜索/配置交互；1440/1024/390px 截图验证易读、关键操作可见与移动逐级导航，无横向溢出。
- [ ] 4.2 接通供应商路由与内联保存、首次自动发现和刷新，DOM/E2E 验证未保存编辑、密钥保留、停用、删除、无配置和错误状态，A 切 B 后迟到响应不会覆盖 B。
- [ ] 4.3 接通候选批量添加、原生参数、启停与默认模型，全局模型可进入同一配置入口；始终展示当前回复上限/可信最大输出/思考支持与默认设置，验证添加后刷新保留元数据及用户覆盖、默认删除不替换、身份不泄露。

## 5. 即时反馈与增量展示

- [x] 5.1 将提交预览与已保存消息分离，慢 create/generate 各两秒的 DOM/浏览器测试验证点击后 100ms 内显示消息、无空欢迎页、成功按 ID 合并且草稿不重复。
- [ ] 5.2 减少冗余 GET 并实现失败/不确定提交对账，回归验证输入恢复不覆盖新草稿、服务端仍校验最新历史、首字前停止与断连不重复提交或复活导航；记录状态机。
- [ ] 5.3 实现受控帧合并、稳定消息引用和高亮缓存，验证已完成消息渲染次数、20k 字符代码/表格性能、复制与 Markdown 正确；停止/删除/退出取消待绘制任务。

## 6. 流式持久化

- [x] 6.1 将增量保存减少到单次原子数据库操作，数据库测试验证归属、影响行数、活动 ID 条件、单请求锁和并发停止/删除/重试；交付 SQL 往返数量前后对比。
- [ ] 6.2 实现有界积累与单写入协调，四协议仿真验证首段、每 50ms 高频片段、慢数据库背压、EOF、错误、终结排空及写失败；所有可见正文已落库，迟到批次不改变终态。
- [ ] 6.3 按 design 固定场景复测至少 30 次，交付正文到 Flush、到浏览器展示、增量渲染 p50/p95 与基线对比；满足 100ms 预览、持久化往返+100ms、32ms 渲染指标，记录条件与剩余瓶颈。

## 7. 集成与审查交接

- [ ] 7.1 运行 go test/vet、sqlc diff、前端 typecheck/lint/test/test:e2e/build、OpenSpec 严格验证；完整回归两用户、四协议、停止、重启、删除、重试、Mock 模式，保存最新证据并恢复真实构建。
- [ ] 7.2 提供六项问题逐一对应的修复证据、三宽度截图、菜单坐标与键盘结果、性能原始样本和测试命令，更新验收记录/开发约定而不抹去原实机输入法未验收记录；交原协作者独立审核。

## Workflow follow-up

- 此变更已部分实施；实施者按最新验收证据与 OpenSpec apply 进度推进，不根据历史交接或旧基线通过自动勾选。
- 用户另行授权后才提交或推送修复、归档变更或调用真实付费模型。
- 真实设备中文输入法与手机软键盘仍需要人工验收，不以自动化代替。

## 实施证据与未勾选项

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
