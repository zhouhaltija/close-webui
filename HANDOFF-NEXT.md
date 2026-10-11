# 交接文件 — fix-provider-setup-and-chat-experience（2026-10-11 收工，明天换机继续）

> 本文件是**明天上班的第一入口**。先读它，再读 `HANDOFF.md` 顶部的"六项体验修复交付记录"章节。
> 代码已全部**本地提交**（未推送）。换电脑前必须先 `git push`，否则新机器上看不到。

---

## 1. 一句话现状

OpenSpec 变更 `fix-provider-setup-and-chat-experience` 的**六项修复已全部实施完成**，单测/Go 测试/构建/OpenSpec 校验全绿；
**唯一未收口的是完整 Playwright E2E**：最近一次全量跑出 `19 passed / 20 failed (9.4m)`，其中约 15 个失败是
`browserContext.close: ENOENT ... .playwright-artifacts-N\traces\...` 的 **Playwright trace 产物基础设施问题**（并发进程清理 `test-results/` 导致），
不是产品回归；剩下少数需要逐个确认（见第 4 节）。

## 2. 明天第一件事（按顺序）

```powershell
cd E:\Projects\close-webui        # 或新机器上重新 clone 后 checkout 该提交
git log --oneline -1              # 确认是本轮修复提交
git push                         # 【必做】不推送则新机器没有这些代码
pnpm install --frozen-lockfile
```

然后**单跑** E2E 逐项确认（不要一上来就全量，先隔离那 15 个 ENOENT 假失败）：

```powershell
# 1) 先确认 trace ENOENT 是否复现（这是最高优先级，它污染了全部结果）
$env:PLAYWRIGHT_CHANNEL='chrome'
node_modules\.bin\playwright test tests/e2e/chat.spec.ts --project=mock --reporter=list --workers=1

# 2) 逐项目跑
node_modules\.bin\playwright test --project=mock --reporter=list --workers=1
node_modules\.bin\playwright test --project=real-api --reporter=list --workers=1
node_modules\.bin\playwright test --project=backend --reporter=list --workers=1

Remove-Item Env:PLAYWRIGHT_CHANNEL
```

**判断标准**：
- 若加 `--workers=1` 后 ENOENT 消失 → 就是并发 worker 争抢 `test-results/` 的基础设施问题，
  可在 `playwright.config.ts` 把 `workers: 2` 改回 1，或给每个 worker 独立 outputDir，然后重跑全量。
- 若仍复现 → 是 trace 落盘竞态，可临时把 `use.trace` 改成 `'off'` 复跑取得真实通过率，
  **但要在 HANDOFF 里注明"本轮关闭了 trace"，不要冒充原设置下的结果**。

## 3. 已确认全绿的证据（不要重跑，直接用）

| 检查 | 命令 | 退出码 |
| --- | --- | --- |
| 前端类型 | `node_modules\.bin\tsc -b` | 0 |
| 前端 lint | `node_modules\.bin\eslint .` | 0 |
| 前端单测 | `node_modules\.bin\vitest run` | 0（13 文件 114 测试） |
| Go 全套 | `node scripts/server.mjs test` | 0（internal/app 约 380–412s） |
| Go vet | `node scripts/server.mjs vet` | 0 |
| OpenSpec | `openspec validate fix-provider-setup-and-chat-experience --strict` | 0 |
| 前端构建 | `node_modules\.bin\vite build` | 0 |
| 真实构建 | `node scripts/frontend.mjs build` | 0 |
| 差异卫生 | `git diff --check` | 0 |

性能数据（`test-results/performance-browser.json`，30 次采样 + 1 次预热）：
- `clickToPreview` **p50=14ms / p95=17ms / max=18.9ms**（目标 ≤100ms）✅
- `oldMessageMutationsTotal = 0`（旧消息零重渲染）✅
- `longTaskCount = 0`（无 >50ms 长任务）✅
- `welcomeOverlapSamples = 0`（无空欢迎页闪现）✅
- `clickToFirstDelta` p50≈1354ms / p95≈2255ms（含 create+submit+上游连接+首次落库，**上游思考时间不计入本系统指标**）
- `deltaInterval` p95≈1944ms：约 7% 的增量间隔约 1.8s，疑为 PostgreSQL 对持续增长的 TOAST `content` 列重写 + 写协程合并所致，**属未解决瓶颈，需明天定位**，不要悄悄降标。

Go 侧实测（远程库 RTT 75–90ms，非假存储）：
- SQL 往返/批：**旧 4 次 → 新 1 次**（计数 `net.Conn` 实测）
- 四协议首段可见延迟 186–238ms（旧实现 200ms ticker + 375ms 四语句 ≈ ≥560ms）
- 慢库背压：600 片段 → 20 次原子写，峰值并发写 = 1

## 4. 需要逐个确认的 E2E 失败（排除 ENOENT 后剩下的）

从 `.cache/e2e-full.log` 里能看到真实断言失败的只有两条，其余都是 ENOENT：

1. **`reference-home.spec.ts:37` — `.desktop-sidebar` 宽度 289，期望 288**（差 1px）。
   基线 29483aa 是通过的。嫌疑：我把 `Composer` 的发送/停止按钮改成**同一个常驻元素**（原来空文本时根本不渲染按钮），
   可能让首页首次布局差 1px。**先查这个**：`git stash` 不掉的情况下，可临时把
   `src/components/Composer.tsx` 的按钮改回条件渲染，单独跑 `reference-home.spec.ts` 比对；
   若确认是它，就把期望改成 289 并在 HANDOFF 说明原因（这是有意的交互修复，不是回归）。
2. **`real-api.spec.ts:12` — `getByRole('alert')` 期望文本 `"服务暂时不可用。"`**。
   需看实际文本；可能与提交预览改造后错误提示路径变化有关。

## 5. 明天不要动的东西（边界）

- **不要** `git push` 以外的任何 Git 写操作前不同知我；不要 archive 变更。
- **不要**修改 `migrations/00001_initial.sql`、不要重建开发库 public、不要对 public 做测试回滚。
- **不要**把 `.env.backend.local`、截图里的私人数据加进 Git。
- **不要**调用真实付费模型；仿真上游结果不能写成"实网冒烟通过"。
- **不要**勾选/声称"真实设备中文输入法与手机软键盘"验收（`build-chat-frontend` 6.4 仍未验收）。

## 6. 环境坑（明天少踩）

- **pnpm shim 偶发联网等待**：`playwright.config.ts` 的 webServer 已改为
  `node node_modules/vite/bin/vite.js preview ...`（等价命令，避开 60s 超时）。
  若还要跑 `pnpm preview` 类命令超时，直接用 node 形式。
- **Go 必须带仓库缓存环境变量**，否则走 `proxy.golang.org` 超时：
  ```powershell
  $env:GOCACHE='E:\Projects\close-webui\.cache\go-build'
  $env:GOPATH='E:\Projects\close-webui\.cache\go-path'
  $env:GOMODCACHE='E:\Projects\close-webui\.cache\go-mod'
  ```
  （`node scripts/server.mjs test/vet` 已内置，直接调 go.exe 时才需要手动设。）
- **本机无 gcc**，Go `-race` 跑不了。
- **E2E 三端口 4173/4174/4175 都是 `reuseExistingServer:false`**，同时只能跑一套；
  之前多个并行进程互相抢端口产生过大量假失败，明天**单人独占窗口**跑。
- **`sqlc` 未安装**：以 `sql/queries.sql` 26 条命名查询 ↔ `internal/db/queries.sql.go` 26 个生成方法
  一一对应、且 `git diff --stat sql/ internal/db/ migrations/` 为空来证明一致（本轮无字段新增，未追加迁移）。

## 7. 代码地图（改了什么）

前端：
- `src/components/RealModelSelector.tsx` — Dialog → Radix Dropdown + 思考子菜单（修复 1）
- `src/styles.css` — `.dropdown [role=menuitem]` 块级整行（修复 2）
- `src/components/ProviderWorkspace.tsx`（新）+ `Settings.tsx` + `api.ts` + `types.ts` + `settings.css` + `main.tsx` 路由（修复 3）
- `src/core/generation.ts` + `App.tsx` + `ui-store.ts` + `types.ts` + `Composer.tsx`（修复 5）
- `src/components/Messages.tsx` — `memo` + `MessageBody`（修复 6 前端）

后端：
- `server/internal/upstream/catalog.go`（新）+ `registry.go`（硅基流动 `zai-org/GLM-5.3-Flash` 精确别名）（修复 4）
- `server/internal/app/model_discovery.go`（新）+ `app.go` 路由（修复 4）
- `server/internal/app/generations.go` — 单条 CTE 原子 SQL + 40ms 合并窗口 + 有界队列单写入协程（修复 6 后端）
- `server/cmd/testserver/main.go` — 新增 `[perf]` 固定 50ms / 20k 字符仿真

测试：
- 新：`RealModelSelector.test.tsx`、`Settings.test.tsx`、`catalog_test.go`、`model_discovery_test.go`、`generations_perf_test.go`、`tests/e2e/{fixes,responsiveness,performance}.spec.ts`
- 改：`generation.test.ts`（+8）、`Composer.test.tsx`、`RealApp.test.tsx`、`tests/e2e/backend.spec.ts`（对齐内联工作区 UI）

## 8. 明确未验收（写进 HANDOFF 了，别删）

1. 真实设备中文输入法与手机软键盘（`build-chat-frontend` 6.4）。
2. 真实供应商付费调用（无密钥）；`zai-org/GLM-5.3-Flash` 在硅基流动是否上架未经真实调用核实。
3. Go `-race`（无 gcc）。
4. 增量渲染 ~7% 间隔约 1.8s 的瓶颈（见第 3 节）。
