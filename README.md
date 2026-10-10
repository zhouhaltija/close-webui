# CloseWebUI

一个借鉴 Claude 核心布局与阅读体验、使用自身品牌的 AI 聊天界面。首版是中文浅色主题的独立 Mock 前端，未来后端计划使用 Go。

## 当前状态

前端已实现新对话首页、历史侧栏、模拟流式回答、停止、失败重试、Markdown/代码复制、重命名、删除和本地恢复。无需后端和模型密钥即可运行。实现由 OpenSpec 变更 `build-chat-frontend` 跟踪，未归档；当前阶段以本地提交保存，尚未配置远程。

开发按用户要求暂停，当前交接说明见 [HANDOFF.md](HANDOFF.md)。任务清单尚未全部核对，未勾选项可能已经实现但尚未完成对应验收，恢复时应先检查现有代码与验证结果。

## 环境要求

- Node.js：建议使用当前环境的 24 LTS（初始化时为 24.18.0）。
- pnpm：11.23.0（packageManager 已固定），用于应用依赖管理。
- OpenSpec：1.14.1，本项目使用 `spec-driven` schema、中文文档与 Codex core 集成。
- Git：用于版本管理。

尚未安装 OpenSpec 时可执行 `npm install -g @fission-ai/openspec@1.14.1`。已初始化的项目无需重复执行 init；更新集成时使用 `openspec update` 并审阅文件差异。

## OpenSpec 工作流程

标准流程为 **proposal → specs → design → tasks → 实现与验收 → archive**。

```powershell
openspec list
openspec status --change build-chat-frontend
openspec validate build-chat-frontend --strict
```

首版规划入口：

- [proposal.md](openspec/changes/build-chat-frontend/proposal.md)：目标、能力范围和排除项。
- [specs](openspec/changes/build-chat-frontend/specs/)：聊天界面、对话管理、流式生成的行为与场景。
- [design.md](openspec/changes/build-chat-frontend/design.md)：技术、视觉变量、接口协议和数据策略。
- [tasks.md](openspec/changes/build-chat-frontend/tasks.md)：实现与验收状态，以复选框和 CLI 进度为准。

OpenSpec 的文档完成状态与实现任务状态不同：规划文档齐全不代表前端已完成。

Codex 集成由 OpenSpec 生成在 `.agents/skills/`，本项目保留这些文件纳入版本管理。可以在 Codex 技能列表选择 `openspec-propose` 创建后续变更；准备实施首版时选择 `openspec-apply-change` 并指定 `build-chat-frontend`，或明确要求应用该变更。实施后经过验收再使用 `openspec-archive-change`，不要提前归档。

## 运行与检查

固定技术栈：React、TypeScript、Vite、Tailwind CSS、Radix UI、React Router、TanStack Query、Zustand、MSW、react-markdown、remark-gfm 和 Shiki。使用 Vitest、React Testing Library 与 Playwright 验证逻辑和用户流程。

实施顺序：应用骨架与主题 → 页面布局 → Mock 接口与持久化 → 流式聊天 → 历史管理 → 集成与视觉验收。

在项目根目录执行：

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

开发地址为 `http://localhost:5173`，生产预览默认 `http://localhost:4173`。服务器仅绑定 localhost。首次运行端到端测试前执行 `pnpm exec playwright install chromium`；`pnpm test:e2e` 自动构建，再在独立的 4173 端口启动生产预览执行测试，避免热更新干扰。

如果已经安装 Chrome，可在 PowerShell 使用本机 Chromium 浏览器：

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
pnpm test:e2e
Remove-Item Env:PLAYWRIGHT_CHANNEL
```

浏览器截图保存到 `test-results/screenshots/`，报告保存到 `playwright-report/`，均已忽略。查看测试报告使用 `pnpm exec playwright show-report`。

## Mock 配置与后端接入

默认配置不需要 .env。需要覆盖时复制 `.env.example` 为 `.env`，修改后重启开发服务器；生产预览需重新构建。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `VITE_ENABLE_MOCK` | `true` | 设为 `false` 后关闭 MSW，使用真实 HTTP 服务 |
| `VITE_API_BASE_URL` | `/api` | 统一 API 基址；未来 Go 服务需实现 design.md 中的协议 |
| `VITE_MOCK_SCENARIO` | `normal` | `normal`、`slow` 或 `failure` |

验收可访问 `/?mockScenario=slow` 或 `/?mockScenario=failure` 覆盖场景，此配置只在 Mock 模式有效。场景在页面启动时固定，导航后仍沿用；failure 在第三个内容增量后失败，重试同一回答将成功。配置项不显示在产品界面。

真实模式不注册 Mock，也不会在服务失败时回退到假数据；没有后端时接口错误是预期结果。所有生成使用 POST fetch 与 NDJSON，取消通过 AbortSignal 传递；未来 Go 服务还需验证连接关闭后的服务端取消。跨来源服务需自行允许前端来源的 CORS。浏览器环境变量不能存放模型密钥。

首版使用带版本号的 localStorage 保存当前站点来源的对话。刷新恢复最近成功保存的内容，未完成生成标记为已停止；草稿只在页面会话中保存。没有账号同步、跨标签页合并或附件存储。

存储键为 `closewebui:data:v1`；损坏或未知版本的数据不会自动覆盖，需要用户确认重置。存储不可用时页面会显示提示，并在内存中继续工作；刷新可能丢失未保存内容。不同端口属于不同来源，开发和预览的历史不互通。

## 验收约定

执行类型检查、lint、单元测试、端到端测试和构建，并在 1440、1024、390px 宽度验收布局、输入、滚动、历史管理及异常恢复。行为以 specs 为准，视觉和实现约定以 design.md 为准。自动化可验证组合输入事件；真实操作系统输入法和手机软键盘需在目标设备上进一步体验。
