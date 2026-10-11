# CloseWebUI 开发约定

## 项目范围

- 当前交付为中文浅色主题的独立 Mock 聊天前端，使用 CloseWebUI 品牌，未来后端使用 Go。用户提供的 Claude 首页截图用于布局、比例、颜色与字体参考；按后续澄清，只呈现项目已实现的功能。不增加 Cowork、项目/账户/升级、附件或语音占位入口，不预设未来 agent 模式名称。最终模型菜单要求见下一条。
- 模型菜单最终约定：保留 Sonnet 5.5 · 中等默认标签及模型选择/努力程度子菜单，按用户第二张截图呈现名称、说明和选中标记；删除“更多模型”、Pro/Max、升级、额度/套餐/用量提示。该要求已同步到 OpenSpec，模型与努力程度选择仅保留在当前页面会话，不代表已接入真实模型；最新实施证据见 HANDOFF.md 顶部。
- 首版包含首页、历史侧栏、流式聊天、停止、失败重试、Markdown/代码复制、重命名、删除和本地恢复。
- 首版不包含真实模型、登录、附件、知识库、工具调用、编辑重发、分支对话或深色主题。扩展范围先更新规划。
- 早期不维护 README.md；环境、开发流程和协作约定统一放在本文件。阶段性验收证据放在 HANDOFF.md，实施状态以 OpenSpec tasks 和 CLI 进度为准。
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
