# Design

## Context

仓库初始为空；本轮已建立 Git、OpenSpec 1.14.1 和 Codex core 技能，没有前端、后端或已有数据。当前可用 Node.js 24.18.0、pnpm 11.23.0。动机见 proposal.md；行为以三个 capability 的规格为准。

以下均为后续实现设计。本次不创建 package.json、不安装应用依赖、不启动应用实现。初始化交付后，新指令可以启动 apply 工作流。

## Goals / Non-Goals

**Goals:** 前端在没有模型密钥和后端时独立运行，接口可以由未来 Go 服务实现；视觉与数据逻辑分离；取消、刷新和重试均有确定行为。

**Non-Goals:** 不建设服务端、认证、SSR、跨标签页同步或复杂插件体系；不以某个未提供的 Claude 截图作为逐像素基准。产品排除项见 proposal.md。

## Decisions

### 1. 技术与职责

- 在仓库根部建立 React + TypeScript + Vite 单应用，pnpm 管理依赖与锁文件；实施时选择相互兼容的稳定版本并提交锁文件，而非本轮安装依赖。
- 使用 Tailwind CSS 与 CSS Variables；Radix UI Dialog、AlertDialog、DropdownMenu、Tooltip 实现弹层与菜单。避免直接套用默认视觉，保证品牌可控。
- React Router：`/` 为首页，`/chat/:conversationId` 为对话；不增加没有首版内容的设置页或模型选择页。
- TanStack Query 保存列表、详情缓存并在创建、生成、重命名、删除后更新或失效；Zustand 仅管理抽屉、按对话保存的会话内草稿及活动请求标识。AbortController 由生成协调器持有，不序列化到 store。
- 页面 → 业务 hooks → API 客户端 → MSW handlers → Mock repository。组件不直接访问 localStorage 或 fixture。MSW browser handlers 在页面环境访问 repository，不能在 service worker 中直接读取 localStorage。
- API 使用 fetch；不引入模型 SDK。相比 Next.js，Vite 更适合独立前后端和当前不需要 SSR 的应用；相比直接把假数据塞进组件，MSW 保留未来接后端的调用路径。
- 消息渲染采用 react-markdown + remark-gfm，禁用原始 HTML，Shiki 按需高亮代码；图标采用 lucide-react。测试使用 Vitest 和 Playwright，补充 React Testing Library 验证中文组合输入等 DOM 行为。

### 2. 视觉基准

采用 Claude 常见侧栏与居中对话布局，使用 CloseWebUI 字标与原创简单几何图形。没有截图时不承诺逐像素一致；后续提供截图，应在编码前修改本设计。

| 变量 | 固定值 |
| --- | --- |
| 页面 / 侧栏 / 卡片 | `#FAF9F5` / `#F0EEE6` / `#FFFFFF` |
| 正文 / 次要正文 | `#262624` / `#6B6862` |
| 边框 / 强调 / 强调悬停 | `#E3DED5` / `#C96442` / `#B55335` |
| 错误文字 | `#B42318` |
| 间距档位 | 4、8、12、16、24、32、48、64px |
| 控件 / 输入卡片 / 弹窗圆角 | 8 / 20 / 16px |
| 控件字体 | `Inter, "Noto Sans SC", "Microsoft YaHei", sans-serif` |
| 回答与欢迎标题字体 | `"Noto Serif SC", "Songti SC", serif` |
| 代码字体 | `"JetBrains Mono", Consolas, monospace` |

字体缺失时按声明回退；首版不依赖在线字体请求。控件正文 14px，聊天正文 16px/1.75，桌面欢迎标题 40px、移动端 28px。长回答左对齐，用户消息使用浅色圆角块，助手内容不使用大型气泡。

- 桌面断点为 768px：侧栏展开宽 280px，折叠宽 64px；默认展开。正文最大宽 768px，首页输入卡片最大宽 720px，左右留白桌面 32px、移动端 16px。
- 小于 768px 默认隐藏侧栏，菜单打开宽 `min(280px, 85vw)` 的抽屉，带遮罩、焦点约束及 Escape 关闭。刷新时不恢复抽屉打开状态。
- 对话区使用独立滚动容器和 flex 布局；输入框保持底部可见，页面高度采用 100dvh，并考虑移动端安全区域。
- 输入框初始最小高 56px、最大高 200px，超出后内部滚动；发送与停止按钮至少 44×44px。
- 代码块、表格有各自横向滚动容器；链接在新标签打开并添加适当 rel。图标按钮显示中文 tooltip 和可访问名称。
- 首页显示“今天想聊些什么？”和四个可填入输入框的建议问题，不自动发送；没有附件、模型菜单或账号占位按钮。
- 在底部距离不超过 80px 时跟随输出；用户向上滚动后暂停，仅按钮或用户返回底部恢复。滚动动画尊重 reduced-motion，流式输出不反复执行平滑动画。

### 3. 数据模型与本地保存

```ts
type MessageStatus = 'pending' | 'streaming' | 'completed' | 'stopped' | 'failed';
type Message = {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  status: MessageStatus;
  createdAt: string;
  error?: { code: string; message: string };
};
type ConversationSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};
type Conversation = ConversationSummary & { messages: Message[] };
type StoredData = { version: 1; conversations: Conversation[] };
```

ID 使用 crypto.randomUUID，日期为 ISO 8601 字符串；用户消息始终为 completed，助手按生命周期变更。消息是首版线性记录，不加入分支字段。localStorage 键为 `closewebui:data:v1`，无记录时为空历史；保存创建、消息提交、每个内容增量、结束、停止、重命名与删除。草稿仅在页面会话中保存，不随刷新恢复。

初始化时验证外层版本与记录字段；pending/streaming 转为 stopped 并保存，不发起生成。无法解析或未知版本时保留原始值并阻止写入，展示恢复页；重置需要确认。读写权限或配额失败时使用当前会话内存状态并持续提示无法保存，不能声称刷新恢复成功。

默认标题取首条消息首行，压缩空白后截取前 24 个 Unicode 字符，超出添加省略号。手动标题 trim 后限制 1–80 字符，重命名不被后续回答自动覆盖。updatedAt 在创建、提交新消息和重命名时更新，增量、停止、恢复和阅读不调整历史排序；同时间按 id 稳定排序。多标签页合并与历史导出后续另行设计。

### 4. API 与流式协议

相对 API 基址默认 `/api`，后续可用 `VITE_API_BASE_URL` 配置。对话接口使用 JSON，列表返回摘要数组，详情返回完整 Conversation；错误统一为 `{ error: { code, message } }`。

| 方法与路径 | 输入 | 成功响应 |
| --- | --- | --- |
| GET `/conversations` | 无 | 200，ConversationSummary[] |
| POST `/conversations` | `{ title: string }` | 201，空消息的 Conversation |
| GET `/conversations/:id` | 无 | 200，Conversation |
| PATCH `/conversations/:id` | `{ title: string }` | 200，ConversationSummary |
| DELETE `/conversations/:id` | 无 | 204 |
| POST `/conversations/:id/generations` | `{ userMessageId, assistantMessageId, content, retry }` | 200，NDJSON 事件流 |

校验失败为 400、对话不存在为 404、活动生成冲突为 409；响应的中文 message 用于用户反馈。创建使用首条输入推导 title；首页先创建空对话并导航，再提交生成，提交失败保留草稿在已创建对话上重发，避免重复创建。该次发送引发的首页到新对话导航属于同一请求的内部过渡，不触发取消；只有用户主动离开当前目标才取消。

生成采用 `Content-Type: application/x-ndjson`，每行一个 JSON，不依赖 TCP chunk 与事件边界一致：

```ts
type GenerationEvent =
  | { type: 'delta'; assistantMessageId: string; content: string }
  | { type: 'done'; assistantMessageId: string }
  | { type: 'error'; assistantMessageId: string; code: string; message: string };
```

客户端提供异步事件迭代器，接受 AbortSignal，使用 TextDecoder 流式解码并缓存未完整的行。允许最后一行没有换行，忽略空行；缺少终结事件、无效 JSON/事件或消息 ID 不匹配均标记失败。done/error 只接受一个终结事件，终结后停止读取。响应头前失败不清空草稿；返回 200 表示消息已原子提交，客户端再清空草稿并展示消息。

首次请求由客户端预生成两个消息 ID，`retry: false`；handler 校验后一次保存用户消息与 pending 助手消息，再返回流。首次增量转 streaming，done 转 completed，error 转 failed。重试只允许最后一条 failed 助手消息，使用原 ID、原用户内容和 `retry: true`，清空失败内容/错误后重新输出，不新增记录。停止不提供重试，用户可发新消息。

选择 NDJSON 而非 WebSocket，是因为只有单向生成且普通 HTTP 更容易接 Go；相比原生 EventSource，fetch 支持 POST 内容及 AbortSignal。

### 5. 取消与请求协调

生成协调器同步抢占活动槽位，覆盖首页创建、提交、等待和流式读取全过程；重复事件不能在 React 更新前穿透锁。TanStack Query 不对生成请求自动重试，重试必须来自明确点击。取消请求后立即清除活动槽位，用 request token 忽略旧回调，所有 finally 仅能释放自身 token。

用户停止、路由切换、删除当前对话时 abort，再把已接受的助手消息标记 stopped。客户端更新缓存并通知 Mock repository 保存取消快照；这属于开发 Mock 的生命周期桥接，不是新增产品 HTTP 端点。repository 与流生产器监听同一取消生命周期并停止定时器，客户端不能只停止渲染而让 Mock 继续写入。取消发生在创建阶段时保留已创建空对话，但不得将用户导航回原页面。

删除必须先停再删，生产器写入前检查 conversation 存在及活动 token，绝不复活记录。客户端检测到流解析错误或意外断开时，同样通过 Mock 生命周期桥接保存 failed 快照并停止生产器，避免刷新后状态与页面不同。刷新通过启动恢复将持久化中的未完成状态终结，卸载时尽力 abort；不依赖异步 beforeunload 完成保存。未来 Go 接入需要让 HTTP 连接关闭取消服务端任务，并在真实模式关闭 Mock 生命周期桥接。

### 6. 固定 Mock 场景与环境

首版默认 `VITE_ENABLE_MOCK=true`，MSW 启动完成后再挂载应用。设为 false 时不注册 handler，完全通过同一 API 客户端请求配置的服务。环境变量不含密钥；关闭 Mock 后没有服务是预期错误，而非回退到假数据。

`VITE_MOCK_SCENARIO` 为 normal（默认）、slow 或 failure，不显示在产品 UI；验收时可在 Mock 模式使用 `?mockScenario=slow` 等参数覆盖。非 Mock 模式忽略这些参数。

- normal：等待 300ms，每 60ms 输出约 24 个 Unicode 字符。
- slow：等待 1500ms，每 300ms 输出约 12 个字符。
- failure：按 normal 速度输出，发送 3 个 delta 后返回固定中文 error；同一失败助手消息的首次 retry 完整成功。
- 所有场景使用相同固定长回答，包含标题、列表、表格及 TypeScript 代码，长度足够验收滚动。每次新发送独立触发所选场景；结果无随机性。
- 单元测试直接注入时钟/数据依赖，E2E 使用独立浏览器上下文清空保存状态，不能给普通用户自动填充示例历史。

### 7. 实施与验证入口

后续 package scripts 固定为 `dev`、`build`、`preview`、`typecheck`、`lint`、`test`、`test:e2e`；dev 默认绑定 localhost。将公共类型、API 客户端、Mock repository 和界面按职责分目录，避免创建 Go monorepo 骨架。

Vitest 重点验证流分帧/UTF-8/错误终结、取消迟到事件、版本恢复、存储异常与重试去重；React Testing Library 验证组合输入和空白提交。Playwright 验证实际页面聊天闭环、刷新、历史管理、取消/切换、失败恢复及滚动。

在 Chromium 上检查 1440、1024、390px 截图；断言页面没有水平溢出，长代码与表格可内部滚动。人工检查视觉层级、焦点、中文输入法与窄屏输入区。截图作为本项目视觉基线，不视为未经提供的 Claude 页面像素证明。

## Risks / Trade-offs

- localStorage 配额、同步写入与多标签页覆盖 → 首版仅小规模文本 Mock，明确异常提示，跨标签页同步留待后续；扩大数据量时再迁移 IndexedDB/后端。
- MSW 流取消可能与 fetch 取消传播不一致 → 用明确生命周期桥接和迟到事件测试验证，不能仅凭 AbortController 存在就认为取消有效。
- 中英文系统字体差异 → 采用确定回退栈并以中文目标设备人工检查；不依赖第三方字体服务。
- Mock 契约无法证明真实服务行为 → 后端接入时补充服务契约与取消集成测试；本轮仅验证规格。

## Migration Plan

当前没有已有应用或数据，不需要迁移。后续先在 Mock 模式交付并验证；Go 接入通过 API 基址和 Mock 开关切换。首版存储仅接受 v1，未知版本保留数据并要求确认重置。实现完成、验收通过后才归档此变更并同步主规格。
