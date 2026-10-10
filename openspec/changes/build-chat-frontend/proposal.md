# Proposal

## Why

CloseWebUI 希望提供贴近 Claude 阅读与交互体验的自托管 AI 聊天界面。先通过独立 Mock 前端验证体验与接口边界，让未来 Go 后端可以接入已稳定的产品流程。

## What Changes

- 建立中文、浅色主题的 React 前端，呈现新对话首页、可折叠侧栏、历史列表和对话页。
- 实现消息发送、模拟流式回答、停止、失败重试、Markdown 和代码块复制。
- 支持对话切换、重命名、删除及浏览器本地保存与刷新恢复。
- 固定统一 API 与流式事件协议，提供可重复的正常、慢速、失败 Mock 场景。
- 验收桌面与移动端布局、中文输入法和流式滚动行为。
- 本次提案阶段仅交付规格；应用实现另行启动。首版排除真实模型、登录、附件、知识库、工具调用、编辑重发、分支对话及深色主题。

## Capabilities

### New Capabilities

- `chat-interface`: 品牌、响应式布局、输入、消息阅读、复制及滚动交互。
- `conversation-management`: 对话创建、历史列表、切换、重命名、删除和本地恢复。
- `chat-generation`: 统一接口下的流式生成、单请求约束、取消、失败重试和可重复 Mock 场景。

### Modified Capabilities

无。仓库尚无已有产品规格。

## Impact

- 后续新增前端应用、开发 Mock 和验收测试；本阶段不安装应用依赖或创建应用代码。
- 技术依赖：React、TypeScript、Vite、pnpm、Tailwind CSS、Radix UI、React Router、TanStack Query、Zustand、MSW、react-markdown、remark-gfm、Shiki、Vitest 和 Playwright。
- 规划浏览器 HTTP API 与 NDJSON 流式事件，供未来 Go 后端实现；当前不访问外部模型服务。
- 本地对话数据限定在当前浏览器与站点来源，不提供账号同步；不涉及已有数据迁移或破坏性兼容变更。
