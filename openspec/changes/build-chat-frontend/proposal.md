# Proposal

## Why

CloseWebUI 希望提供贴近 Claude 阅读与交互体验的自托管 AI 聊天界面。用户提供首页截图，随后明确只借鉴其布局、比例、字体和留白，页面使用自身品牌及已实现功能；同时通过独立 Mock 前端保留可验证的聊天体验与未来 Go 接口边界。

## What Changes

- 建立中文、浅色主题的 React 前端，参考提供的 Claude 截图调整 CloseWebUI 字标、可折叠侧栏、新对话首页、历史列表和对话页。
- 实现消息发送、模拟流式回答、停止、失败重试、Markdown 和代码块复制。
- 支持对话切换、重命名、删除及浏览器本地保存与刷新恢复。
- 固定统一 API 与流式事件协议，提供可重复的正常、慢速、失败 Mock 场景。
- 验收 1878×983 参考截图的桌面位置、尺寸、背景、字形及控件，兼顾 1440/1024/390px 布局、中文输入法和流式滚动行为。
- 首页输入区默认显示 Sonnet 5.5 · 中等标签，提供模型选择和努力程度子菜单，按第二张截图保留名称、说明及选中标记，移除更多模型、Pro/Max、升级、额度和套餐内容。选择暂保存在界面会话内，不表示已接入真实模型。
- 侧栏支持真实历史搜索和排序，不呈现尚未实现的 Cowork 或外部服务入口，不预设未来 agent 模式名称。
- 欢迎语按当前时段随机选择，在进入首页时抽取，输入和菜单操作期间保持稳定。
- 首版排除真实模型、登录、附件、知识库、工具调用、编辑重发、分支对话及深色主题。

## Capabilities

### New Capabilities

- `chat-interface`: 品牌、响应式布局、输入、消息阅读、复制及滚动交互。
- `conversation-management`: 对话创建、历史列表、切换、重命名、删除和本地恢复。
- `chat-generation`: 统一接口下的流式生成、单请求约束、取消、失败重试和可重复 Mock 场景。

### Modified Capabilities

无。仓库尚无已有产品规格。

## Impact

- 前端应用、开发 Mock 和验收测试已经建立；本轮调整现有界面，补齐参考布局、随机欢迎语、模型菜单及验收证据。
- 技术依赖：React、TypeScript、Vite、pnpm、Tailwind CSS、Radix UI、React Router、TanStack Query、Zustand、MSW、react-markdown、remark-gfm、Shiki、Vitest 和 Playwright。
- 规划浏览器 HTTP API 与 NDJSON 流式事件，供未来 Go 后端实现；当前不访问外部模型服务。
- 本地对话数据限定在当前浏览器与站点来源，不提供账号同步；不涉及已有数据迁移或破坏性兼容变更。
