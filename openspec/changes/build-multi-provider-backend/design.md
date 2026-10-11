# Design

## Context

动机见 proposal.md。当前 React API 与 NDJSON 已分离，Mock localStorage 通过生命周期桥接保存，真实模式不回退假数据。旧前端变更尚有实机输入法验收未完成。本变更新增 Go 服务与身份边界，复用原接口，不迁移浏览器私人历史。

## Goals / Non-Goals

**Goals:** 单体单实例多用户服务、原生能力配置、可靠取消与数据库保存、同源部署。

**Non-Goals:** 多实例生成调度、共享平台密钥、管理员后台、附件、工具、知识库、计费、邮件、外部登录。

## Decisions

### 技术与存储

server/ 为独立 Go 模块，使用 chi、pgx、sqlc 和 goose；Go 工具缓存于忽略目录，不改系统安装。PostgreSQL 使用 UUID、timestamptz、JSONB，建立 users、sessions、providers、models、preferences、conversations、messages、generations。消息包含 ordinal、原生续接 metadata；生成包含用户/对话/助手 ID、状态、输入及非秘密参数快照。取消可先创建只有归属和取消意图的 generation 记录。数据库事务锁定对话，部分唯一索引限制活动生成，条件更新必须匹配活动 generation ID。sqlc 生成类型化查询，测试用独立 schema。

### 安全与会话

Argon2id 散列密码，随机会话 token 的 SHA-256 摘要入库，七天绝对期限，HttpOnly/SameSite=Lax Cookie。写请求验证 Origin；生产 Secure Cookie 与 HTTPS，登录/注册限速。AES-GCM 主密钥从后端环境读取；供应商密钥响应只包含 hasKey，空白更新保留原密钥。密码变更注销所有会话。全部资源查询以 user_id 限制归属。公网 HTTPS 出站在实际 Dial 时检查所有解析地址，内网通过服务端允许列表授权；关闭重定向，限制响应体和超时。

### HTTP 契约

- 错误沿用 {error:{code,message}}，中文 message；400 校验、401 会话、404 不存在/非本人、409 冲突。
- auth: POST register/login/logout/password，GET me；注册/登录返回 {id,username}，password 输入 {currentPassword,newPassword}。
- GET provider-templates 返回 {id,name,protocol,adapter,baseUrl}[]；protocol 为 openai-chat/openai-responses/gemini/anthropic；adapter 为 standard/openrouter/siliconflow/deepseek/qwen/kimi/glm。
- providers CRUD 返回 {id,name,templateId,protocol,adapter,baseUrl,enabled,hasKey}；写入附可选 apiKey。POST /providers/:id/discover 返回 {id,name}[]，不自动创建模型。
- models CRUD 返回 {id,providerId,modelId,name,enabled,maxOutputTokens,defaultReasoning,capabilities}；capabilities 包含 family、efforts、supportsToggle、mandatory、budgetMin/budgetMax、budgetSupported、outputMax、sources、known。defaultReasoning 为 {enabled?,effort?,budgetTokens?}，省略表示供应商默认。
- preferences GET/PATCH 返回 {defaultModelId}，空为 null。
- 对话接口形状复用现有前端；助手消息增加可选 modelId、generationId、reasoning，原生 metadata 不回传浏览器。
- generation 输入保留 userMessageId、assistantMessageId、content、retry，加 generationId、modelId、reasoning；POST /conversations/:id/generations/:generationId/stop 幂等记录取消并返回 204。

### 供应商与模型适配

upstream 独立包提供模板、能力、参数校验、四种流式调用与模型发现；只处理文本，按准确已核实 ID/快照别名登记，来源记录在注册表。自定义兼容站可选择内置参数适配，不提供任意字段映射。OpenRouter 和硅基流动采用独立覆盖，不将官方参数强行套入网关。未知模型用默认普通文本请求，不允许未核实思考参数。默认输出上限为已知能力的安全值或未知 4096，预算必须符合模型与输出上限。上游正文仅转为 delta，metadata 保留原生思考、签名及必要续接信息，只在相同供应商和模型续接。

### 生成生命周期

首个 200 前原子保存消息及参数快照；200 头立即 Flush。合并增量每 200ms 或达到 4KB 后事务保存再发出；每 15 秒空行心跳，禁用反向代理缓冲。终结必须先保存再发事件。连接取消、显式停止及删除都会调用同一 cancel，终结落库使用独立短时 context。取消意图先到则拒绝对应 generation，所有迟到更新以活动 ID 与状态条件过滤。重试仅最后 failed 消息，读取原 snapshot 并分配新 generation ID，保留原消息 ID；不用当前菜单覆盖。启动恢复 pending/streaming 为 stopped；该策略只适用于单实例。

### 前端与测试边界

真实模式新增登录/注册边界与 /settings/providers、/settings/models、/settings/account。settings 左侧 192px 分类，内容最大 880px，沿用现有变量；768px 以下顶部分类与单列。菜单从 API 模型列表驱动，未配置时禁止发送。注册表能力由 API 返回，Zustand 只保存临时选择/草稿，持久偏好通过 API。退出清理 Query、UI 和生成。保留 Mock 单独配置及原固定菜单回归；真实接口网络边界测试明确登录和模型 fixtures，新增启动真实 Go 和本地仿真上游的 E2E。Vite /api 代理到 localhost:8080，Go 托管 dist 并回退 SPA 路由。

## Risks / Trade-offs

- 第三方能力变更 → 注册表记录来源，未知型号不猜测，协议契约测试与真实冒烟证据分开。
- 开发数据库无 TLS → 本地环境显式 disable；生产要求 require/verify 模式，凭据和测试 schema 不入 Git。
- 无真实模型密钥 → 仿真网络测试确定实现正确；真实供应商调用明确记为待验证。

## Migration Plan

先更新 OpenSpec 与项目范围，再生成 SQL 查询及运行开发库迁移；迁移不会导入浏览器历史。测试 schema 独立创建与清理。生产运行迁移命令后启动，回滚使用 goose down，不能对已有用户数据自动执行破坏性回滚。未要求 Git 集成或归档。
