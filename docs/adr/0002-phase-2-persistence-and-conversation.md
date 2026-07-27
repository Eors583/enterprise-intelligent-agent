# ADR-0002：Phase 2 持久化与会话账本

- 状态：Accepted / Implemented（direct 会话与消息账本切片）
- 日期：2026-07-15
- 复审：腾讯云 IM POC 与正式 OIDC 接入完成后

## 背景

第一阶段已经贯通桌面端、NestJS API 与 AI Runtime，但组织数据和会话仍使用进程内状态。第二阶段需要先确定数据事实源、租户隔离、消息幂等和外部 IM 的职责边界，否则接入腾讯云 IM 后容易把厂商漫游记录误当成业务事实，导致审计、搜索、AI 上下文和供应商迁移受制于传输层。

## 决策

1. PostgreSQL 是租户、组织、Agent、会话元数据和消息账本的权威事实源；Redis 不保存不可重建的业务事实。
2. 所有租户业务表必须包含 `tenant_id`，应用层查询显式携带租户条件；PostgreSQL RLS 与 `FORCE ROW LEVEL SECURITY` 作为第二道隔离边界。
3. 应用运行连接在事务开始时设置 `app.tenant_id`。迁移角色与应用角色分离，生产应用角色不得拥有 `BYPASSRLS`。
4. `REPOSITORY_DRIVER=memory` 只允许开发与测试；生产启动必须拒绝内存仓储。
5. 首个会话模型只实现租户内一对一真人会话和个人 Agent 会话。群聊、外部联系人和跨租户会话需要单独的授权与合规设计。
6. 客户端发送消息必须提供 `clientMessageId`；服务端在 `(tenant_id, conversation_id, sender_id, client_message_id)` 范围内幂等，重试返回已有消息而不是重复写入。
7. 会话成员关系由自有后端授权并落库。腾讯云 IM 后续作为投递、多端同步和漫游适配器，其成员和群状态只是投影，不是企业授权事实源。
8. 消息入库与待投递事件在同一事务写入 Outbox。外部 IM 调用、搜索索引、通知和 AI 触发由异步消费者处理，不能包在数据库长事务中。
9. Agent 回复必须带明确的 AI 身份。用户消息进入账本后可创建 Agent Run；Run 状态、输出和错误独立保存，不能伪造为已完成的聊天回复。
10. 桌面端通过共享 Zod 契约访问会话 API；加载、空状态、失败、重试和发送中状态必须显式呈现，不回退到静态成功数据。

## 当前实现映射

- `20260715000100_initial` 建立租户目录、Agent、会话、消息、Outbox/Audit schema，并对租户表启用 `ENABLE/FORCE ROW LEVEL SECURITY`。
- `20260715000200_tenant_scoped_foreign_keys` 为业务父表增加 `(tenant_id, id)` 候选键，并把 21 条业务关系替换为租户复合外键；根关系 `tenant_id -> tenants.id` 保持单列。
- `20260715000300_security_policies` 把 `tenant_isolation` 重建为适用于 `PUBLIC` 的 `RESTRICTIVE` policy，收紧应用/provisioning 权限，并增加“消息发送者必须是活跃参与者”的数据库触发器。详细角色决策见 [ADR-0003](./0003-database-security-boundaries.md)。
- 桌面端已实现会话列表、创建/复用、消息读取、文本发送和复用同一 `clientMessageId` 的失败重试；只有服务端返回 `sender.type=agent` 才显示 AI 身份。
- AI Runtime 已能独立执行 OpenAI-compatible Run，但 API 尚未创建持久化 Agent Run，也没有从 Agent 会话自动触发模型回复。

## API 边界

第二阶段的最小 API 为：

- `GET /api/v1/conversations`：列出当前用户有权访问的会话；
- `POST /api/v1/conversations`：按真人或 Agent 目标创建或复用一对一会话；
- `GET /api/v1/conversations/:id/messages`：按稳定顺序读取已授权消息；
- `POST /api/v1/conversations/:id/messages`：幂等写入文本消息。

请求中的租户和发送者身份一律不可信。服务端只从已验证的请求上下文取得 `tenantId` 与 `userId`，并在仓储和数据库策略中再次限制。

## 暂不纳入本决策

- 腾讯云 IM SDK、回调签名、群聊和消息对账；
- OIDC/SAML 提供商的具体选择和令牌交换；
- 消息分页/游标、富媒体上传、撤回、编辑、已读游标和全文检索；
- API 到 AI Runtime 的服务身份、Run 持久化与 Agent 自动回复；
- Agent 自动调用高风险工具。

这些能力必须建立在本 ADR 的事实源、幂等、Outbox 和租户隔离约束之上。

## 后果

- 本地开发可以在没有外部云账号时完成完整的会话写入与读取闭环。
- 接入腾讯云 IM 时需要实现 Outbox 消费、回调幂等和周期对账，但无需迁移核心会话数据模型。
- RLS 会增加迁移和连接管理复杂度，测试必须覆盖缺失租户上下文、错误租户和跨租户 ID 三类失败路径。
- 正式共享试用仍以 OIDC、独立生产数据库登录凭据与角色 membership 验证、密钥托管、Outbox/审计消费者和备份恢复验证为上线门槛。
