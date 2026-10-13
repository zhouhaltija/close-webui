# CloseWebUI 开发约定

## 项目范围

- 当前新增交付为 `build-multi-provider-backend`：Go + chi + PostgreSQL + pgx + sqlc + goose，多用户用户名密码注册登录、每用户私人供应商与历史、四种协议、七个家族内置思考能力及 Claude 风格供应商/模型/账号设置页。以下首版 Mock 约定仍适用于独立 Mock 模式；真实模式使用 API 返回的启用模型与原生能力，不用固定展示名称假装真实接入。用户已明确授权本轮实施方案。
- 后端位于 `server/`，本轮单体单实例，不包含共享平台密钥、管理员控制台、邮件找回、第三方登录、附件、知识库、工具调用、计费和配置导入。开发数据库凭据与加密主密钥只放忽略的 `.env.backend.local`；禁止使用 `VITE_` 存放秘密。原前端变更的实机输入法验收仍未完成，不自动勾选或归档。

- 独立 Mock 前端为中文浅色主题，使用 CloseWebUI 品牌。用户提供的 Claude 首页截图用于布局、比例、颜色与字体参考；按后续澄清，只呈现项目已实现的功能。Mock 不增加 Cowork、项目/账户/升级、附件或语音占位入口，不预设未来 agent 模式名称。最终 Mock 模型菜单要求见下一条；真实模式包含上文已实现的账号入口。
- 模型菜单最终约定：保留 Sonnet 5.5 · 中等默认标签及模型选择/努力程度子菜单，按用户第二张截图呈现名称、说明和选中标记；删除“更多模型”、Pro/Max、升级、额度/套餐/用量提示。该要求已同步到 OpenSpec，模型与努力程度选择仅保留在当前页面会话，不代表已接入真实模型；实施状态见对应 OpenSpec tasks。
- 首版包含首页、历史侧栏、流式聊天、停止、失败重试、Markdown/代码复制、重命名、删除和本地恢复。
- 首版不包含真实模型、登录、附件、知识库、工具调用、编辑重发、分支对话或深色主题。扩展范围先更新规划。
- 早期不维护 README.md；环境、开发流程和协作约定统一放在本文件。阶段性验收证据记录在对应 OpenSpec tasks，实施状态以 tasks 和 CLI 进度为准。
- 项目代码采用 GNU Affero General Public License v3.0（SPDX：`AGPL-3.0-only`），完整文本见根目录 `LICENSE`；第三方依赖及参考素材仍遵循各自许可证和权利声明。
- 用户提供的截图与账户数据仅作本地参考，不纳入 Git；视觉验收使用虚构历史，提交前检查截图、测试数据和文档是否包含用户名、真实对话标题或其他个人信息。

## 技术与目录

- 能满足需求时优先使用成熟、维护良好的第三方库，避免重复实现已有通用能力；引入前核对所用版本及相关依赖的许可证是否兼容项目用途和分发方式，并遵守版权声明、许可证文本保留及适用的源码公开等义务。
- React、TypeScript、Vite、pnpm；Tailwind CSS 和 CSS Variables 管理视觉，Radix UI 管理基础交互。
- React Router 管理路由，TanStack Query 管理接口数据，Zustand 仅保存临时界面状态和会话内草稿。
- `src/core/`：公共类型、fetch API、NDJSON 解析、生成协调器和状态；`src/mocks/`：MSW handlers、repository 和固定回答；`src/components/`：界面组件。
- 消息使用 react-markdown、remark-gfm 和 Shiki；禁止原始 HTML，不依赖在线字体或提供商 SDK。
- 组件通过统一 API 访问数据，不直接访问 localStorage 或 Mock fixture。取消与 Mock 持久化通过 runtime 生命周期桥接。
- Vitest/React Testing Library 验证逻辑和 DOM 行为；Playwright 验证生产预览中的用户流程。

## 环境与命令

Node.js 24 LTS，pnpm 11.23.0（见 packageManager），OpenSpec 1.14.1。应用依赖仅使用 pnpm，保留锁文件。

```powershell
pnpm install --frozen-lockfile
pnpm dev
pnpm typecheck
pnpm lint
pnpm test
pnpm test:e2e
pnpm build
pnpm preview
```

开发地址为 `http://localhost:5173`，生产预览为 `http://localhost:4173`，只绑定 localhost。E2E 自动构建并启动独立的 4173 Mock 预览及 4174 真实接口模式预览，不复用已有服务器。后者通过 `test:real-server` 构建至忽略的 `.test-dist/real/`，关闭 Mock 并使用 `/integration-api` 基址；测试通过浏览器网络边界提供响应，不需要 Go 后端。

### Go 后端与真实联调

需要 Go 1.27+；本机已校验 Go 1.27.2，缓存路径为 `.cache/toolchain/go/bin/go.exe`，脚本优先使用缓存，其他机器回退系统 Go。sqlc 1.30.0 为代码生成工具，服务不要求全局 goose CLI；迁移嵌入二进制。后端运行依赖及完整许可证见 `server/THIRD_PARTY_NOTICES.md`。

后端从仓库根部忽略的 `.env.backend.local` 读取配置，示例见 `server/.env.example`。实际数据库凭据和 32 字节随机加密主密钥不得进入 Git；主密钥需保存，修改后原供应商密钥不能解密。开发库已建表，TLS 未启用；生产要求 `COOKIE_SECURE=true`、HTTPS `PUBLIC_ORIGIN` 与 PostgreSQL `sslmode=require/verify-ca/verify-full`。

```powershell
pnpm server:migrate  # 显式执行 goose up
pnpm server:dev      # 127.0.0.1:8080 Go 服务
pnpm dev:real        # 另一个终端启动 5173 真实前端，/api 同源代理至 8080
pnpm server:test
pnpm server:vet
pnpm server:build    # 构建真实前端 dist 及 .cache/bin 中的服务二进制
```

`pnpm dev` 与常规 `pnpm build` 仍为独立 Mock 默认入口；`pnpm build:real` 明确构建真实前端。运行服务二进制时应以 `server/` 为工作目录，默认托管 `../dist`。部署由 HTTPS 反向代理转发，流式路由关闭缓冲。内网网关必须通过 `UPSTREAM_ALLOWED_HOSTS` 精确填写 `host:port` 允许；用户不能自行放开出站策略。

完整 E2E 增加 4175 真实 Go 模式：启动本地仿真上游、独立 `closewebui_e2e_<随机ID>` schema 和 `.test-dist/backend`；结束经测试专用关闭入口等待 schema 清理。Go 数据库测试也使用独立随机 schema；不得对 public 或用户数据库做测试回滚。此测试入口只存在于 `cmd/testserver`，生产服务不包含。实网供应商尚无密钥，不能把仿真成功表达为真实调用已经通过。

`server:test` 的套件超时为 25 分钟，保留全部断言；远端数据库往返较高时完整套件可能超过 Go 默认 10 分钟。测试夹具初始化另外使用 90 秒超时。性能测试单独串行运行，不与数据库 suite/E2E 同时执行：`RUN_PERFORMANCE=1` 启用 `TestGenerationStagePerformance`，每协议预热一次并采样 30 次；`PERF_IMPLEMENTATION` 标注当前或实际 Git 基线，`PERF_OUTPUT_DIR` 指向忽略的测试产物目录。不得用重构的近似旧实现代替基线，不把网络写入计数称为数据包计数。浏览器生产预览测量增量接收到 DOM 的延迟；单独的 React profiling 构建才能报告纯渲染耗时和实际消息函数执行数，必须注明 profiling 开销且不把钩子加入正常产品构建。测试专用性能时点接口只在 `cmd/testserver` 中存在，记录虚构样本的标识与时间，不记录正文或凭据。

浏览器 30 次性能采样在常规 E2E 中跳过，仅在独占窗口设置 `RUN_BROWSER_PERFORMANCE=1` 后运行 `pnpm exec playwright test tests/e2e/performance.spec.ts --project=backend --workers=1`，结束移除该变量。Go 性能入口为 `node scripts/performance.mjs current` / `node scripts/performance.mjs 29483aa`；新输出默认保存到忽略的 `test-results/performance-parallel-v2/`，与历史保存后发送样本分开。正文到发送和到保存按片段分别关联，保存耗时与最终排空等待单独报告。

首次 E2E 前运行 `pnpm exec playwright install chromium`。本机已安装 Chrome，可使用：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm test:e2e
Remove-Item Env:PLAYWRIGHT_CHANNEL
```

截图在 `test-results/screenshots/`，报告在 `playwright-report/`，均已忽略。查看报告使用 `pnpm exec playwright show-report`。

## OpenSpec 工作流

流程：proposal → specs → design → tasks → 实现与验收 → archive。文档使用中文，保留结构标题及 SHALL/MUST 关键字。

```powershell
openspec list --json
openspec status --change build-chat-frontend --json
openspec instructions apply --change build-chat-frontend --json
openspec validate build-chat-frontend --strict
```

- 当前变更为 `openspec/changes/build-chat-frontend/`，读取 proposal、三份 specs、design 和 tasks 后再实施。
- 多供应商后端当前变更为 `openspec/changes/build-multi-provider-backend/`，实施以其 proposal、五份 specs、design、tasks 和 CLI apply 进度为准；原前端 Mock 变更继续保留。
- 使用 `.agents/skills/` 中的 OpenSpec 技能；新增变更使用 propose，实施使用 apply，修订规划使用 update-change。
- 按骨架与主题 → 页面布局 → Mock 与持久化 → 流式聊天 → 历史管理 → 集成与视觉验收推进。
- 规划齐全不代表实现完成；未勾选项也可能已有实现。先核对代码和验收条件，再补齐缺口。
- 只在任务全部验收条件满足后勾选，并用 apply instructions 确认进度。不能用自动化事件测试代替真实设备输入法/软键盘验收。
- 行为以 specs 为准，视觉、接口、数据和取消策略以 design 为准；变更后运行严格验证。
- 实现、验收和审阅完成后再归档并同步主规格。未经明确要求不自动归档、Git 提交、配置远程或推送。
- 未安装 CLI 时可运行 `npm install -g @fission-ai/openspec@1.14.1`。已初始化项目无需再次 init；更新集成使用 `openspec update` 并审阅差异。

## 开发技能

技能从 `~/.agents/skills/<名称>/SKILL.md` 读取，按任务使用，不复制正文，也不引用已经移除的编排技能。用户明确指令优先；技能缺失时说明限制，不假装已执行。

| 技能                             | 触发条件                                                     |
| -------------------------------- | ------------------------------------------------------------ |
| `test-driven-development`        | 功能、缺陷或行为变化的实现阶段，先红后绿；纯文档迁移不补造业务测试 |
| `systematic-debugging`           | 错误、测试失败或异常行为，先找根因再修复                     |
| `requesting-code-review`         | 重要功能完成或合并前独立审查                                 |
| `receiving-code-review`          | 接收审查意见，核实技术依据后处理                             |
| `verification-before-completion` | 声明完成、通过或准备交付前核验最新证据                       |
| `using-git-worktrees`            | 业务开发需要隔离时，先检查现有隔离及用户偏好                 |
| `dispatching-parallel-agents`    | 多个可独立开展的任务，按技能要求组织并行工作                 |
| `finishing-a-development-branch` | 验收通过后的分支集成或清理                                   |
| `diagnosing-superpowers`         | 用户要求诊断 Superpowers 会话或成本问题                      |

## Mock 与后端接入

默认无需 .env；覆盖配置时复制 `.env.example` 为 `.env`，开发服务器需重启，生产预览需重新构建。

| 变量 | 默认值 | 行为 |
| --- | --- | --- |
| `VITE_ENABLE_MOCK` | `true` | `false` 关闭 MSW，使用真实 HTTP 服务 |
| `VITE_API_BASE_URL` | `/api` | 统一接口基址，Go 服务协议见 design.md |
| `VITE_MOCK_SCENARIO` | `normal` | `normal`、`slow` 或 `failure` |

- Mock 模式可通过 `/?mockScenario=slow` 或 `/?mockScenario=failure` 覆盖场景；启动时固定，导航后沿用，配置不显示在产品界面。
- 三个场景使用同一固定长回答；failure 在第三个增量后失败，同一回答重试成功。
- 真实模式不注册 Mock，不使用生命周期桥接，不在服务失败时回退假数据；无后端时显示接口错误。
- 生成使用 POST fetch 和 NDJSON，取消传递 AbortSignal。Go 接入需验证连接关闭后的服务端取消，跨来源服务配置 CORS。
- 2026-10-13 用户确认真实模式正文发送与数据库保存并行：初始消息对和快照仍原子保存，正文进入有界队列后即发送，顺序合并写入；全部正文和终态保存成功才发 done。队列额度包含正在写入的字节，饱和时向上游背压；保存失败明确提示，刷新或服务崩溃仅恢复已保存部分，最新显示尾段可能丢失。新约定以 `fix-provider-setup-and-chat-experience` 为准，覆盖历史交接中的逐批保存后发送保证。
- 真实模式刷新读到排空中的非终态前缀时只读重取，终态后停止，不因缺少本地 active 自动停止其他标签页。服务端仅按单实例活动任务表识别已退出的孤立生成并用原生成围栏恢复 stopped；仍运行或排空的任务保持原生命周期。
- 浏览器环境变量不得存放模型密钥。

## 数据与验收

- localStorage 键为 `closewebui:data:v1`，仅接受 v1。对话属于当前浏览器来源，不同端口的历史不互通。
- 创建、消息提交、增量、完成、停止、重命名和删除均保存；刷新恢复最近成功保存的内容，未完成回答转 stopped，不自动重发。
- 草稿仅在当前页面会话保存；无账号同步、跨标签页合并或附件存储。
- 损坏/未知版本数据不得自动覆盖，必须经用户确认才重置；存储不可用时提示并在内存继续，刷新可能丢失未保存内容。
- 改行为先补回归测试；检查单请求锁、首个增量前停止、迟到事件、删除不复活、流错误终结、重试不重复用户消息。
- 完成前运行 typecheck、lint、test、test:e2e、build 和 OpenSpec 严格验证，记录实际结果。
- Chromium 验收 1440、1024、390px：首页与对话截图、无页面横向溢出、代码/表格内部滚动、移动抽屉、输入框可见、长回答跟随和恢复。
- 首页视觉基准采用 design.md 中记录的参考图几何参数（1878×983）；原始账户截图不入库。相同视口与虚构历史验收数据核对侧栏、欢迎标题和输入卡片位置，保留自身品牌及真实功能；不复制商业功能或个人历史数据。欢迎语按本地时段随机选择，输入和菜单更新期间保持稳定。
- 人工验收复制结果、Tab/Escape 和焦点恢复；目标设备中文输入法与手机软键盘的未验收项必须明确记录，不能提前勾选。
