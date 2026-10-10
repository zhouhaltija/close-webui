# 开发暂停交接

暂停日期：2026-10-10。用户要求下班前暂停剩余开发，并创建一个本地阶段性提交；未推送远程，不归档 OpenSpec 变更。

## 当前实现

- React + TypeScript + Vite、pnpm、Tailwind、Radix UI、Query、Zustand 和 MSW 已接通。
- 中文浅色首页、桌面/移动侧栏、历史对话、流式回答、停止、失败重试、Markdown/代码高亮与复制。
- 对话重命名、删除、本地版本化保存、刷新恢复、损坏数据确认重置。
- 接口与状态层分离；未来可关闭 Mock 后接 Go 服务。
- 已修复审查指出的生成中重命名回退、错误存储字段类型和管理弹窗焦点回退；加强创建阶段导航取消检查。

## 已完成的验证

暂停前最近一轮：

- `pnpm typecheck`：通过。
- `pnpm lint`：通过。
- `pnpm test`：30 个测试通过。
- `$env:PLAYWRIGHT_CHANNEL='chrome'; pnpm test:e2e`：生产构建通过，12 个 Chromium Chrome 场景通过。
- 桌面与移动截图位于 `test-results/screenshots/`，属于忽略的本地验收产物；不会纳入提交。

浏览器场景覆盖聊天闭环、刷新恢复、取消后无存储增长、失败重试、损坏数据保护、建议问题只填入、抽屉焦点恢复、导航取消、不存在对话、自动滚动、标题校验、生成中重命名及 1440/1024/390px 布局。

## 恢复开发入口

继续使用 `build-chat-frontend` 的 apply 工作流。已记录的任务进度为 **9/29**；后续新增实现和验证尚未全部同步勾选。**先对照已有代码和上面的通过证据核对任务，不要把未勾选等同于未开发。**

仍需收尾：

- 逐项核对剩余任务的全部验收条件，并更新 OpenSpec 状态。
- 完成关闭 Mock、真实服务失败时不回退到模拟数据的实际运行检查；相关实现已有，专用检查尚未执行。
- 检查未覆盖的管理/异常边界及审查修复的最终状态。
- 在目标设备实际体验中文操作系统输入法、手机软键盘及完整键盘交互；自动化组合输入事件不能替代设备验收。
- 整理最终验收记录，完成后再考虑归档；本次不归档。

## 本地运行

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

开发地址为 `http://localhost:5173`。暂停时已停止开发、真实模式检查服务器和浏览器下载。Chromium 自动下载尚未完成；本机已安装 Chrome，可设置 `PLAYWRIGHT_CHANNEL=chrome` 执行测试。其他机器可执行 `pnpm exec playwright install chromium`。

没有后端、登录、真实模型调用、附件或知识库；当前回答来自固定 Mock fixture。数据与草稿的边界见 README 和 design.md。
