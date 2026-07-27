# ADR-0003：数据库租户隔离与角色边界

- 状态：Accepted / Implemented（本地 PostgreSQL 基线）
- 日期：2026-07-15
- 复审：正式身份提供商与首个后台 Worker 接入前

## 背景

仅在 ORM 查询中追加 `tenant_id` 不能构成企业多租户隔离。PostgreSQL 的表所有者和超级用户可以绕过普通 RLS；单列业务外键还可能允许租户 A 的子记录引用租户 B 的父记录。若应用、迁移、组织同步和后台 Worker 共用高权限身份，任何一处注入、配置错误或未审阅 SQL 都可能扩大影响面。

## 决策

1. 所有应用事务先使用 `SET LOCAL ROLE enterprise_agent_app` 降权，再通过 `set_config('app.tenant_id', tenantId, true)` 设置仅事务有效的租户上下文。
2. `enterprise_agent_app` 是 `NOLOGIN`、`NOSUPERUSER`、`NOBYPASSRLS` 的固定角色。生产应用登录身份只获得切换到该角色的资格，不得拥有迁移或 provisioning 角色。
3. 开发 seed 和组织主数据初始化使用独立的 `enterprise_agent_provisioner` 角色。该角色同样 `NOLOGIN`、`NOBYPASSRLS`，只拥有初始化租户、人员、组织和 Agent 目录所需的读写权限。
4. Migration 身份、应用登录身份和 provisioning 身份分离。应用与 provisioner 均不得读取或修改 `_prisma_migrations`。
5. 应用角色对租户/组织/人员/Agent 目录只读；对会话和参与者按当前用例授予 `SELECT/INSERT/UPDATE`；消息只允许 `SELECT/INSERT`；Outbox 与 Audit 只允许追加和读取返回值。
6. 所有租户表启用并强制 RLS。`tenant_isolation` 使用 `RESTRICTIVE` policy；应用或 provisioning 的业务访问使用独立 `PERMISSIVE` policy，未来新增 permissive policy 不能通过 OR 绕开租户条件。
7. 所有同租户业务关系使用 `(tenant_id, id)` 候选键和复合外键。根租户关系继续使用 `tenant_id -> tenants.id`。
8. Message 插入由数据库触发器再次验证 sender 是同租户、同会话、未离开的参与者；HTTP Service 的成员校验不是唯一防线。
9. Readiness 必须验证受限角色、关键表、FORCE RLS、租户 policy 和缺少 tenant context 时的默认拒绝，不能只执行 `SELECT 1`。
10. 租户为 `SUSPENDED` 或 `ARCHIVED` 时，身份服务在进入业务域前拒绝请求。

## 当前实现映射

- Migration `20260715000200_tenant_scoped_foreign_keys` 实现复合候选键与 21 条租户复合外键；它不修复或删除数据，既有跨租户引用会令整个事务失败。
- Migration `20260715000300_security_policies` 创建/收紧 `enterprise_agent_provisioner`，撤销 001 中应用角色的宽泛/default privileges，再按当前用例显式授权；应用和 provisioner 均无 `_prisma_migrations` 权限。
- 003 为每张租户表创建适用于 `PUBLIC` 的 `RESTRICTIVE tenant_isolation`，并仅给应用角色及允许 provisioning 的目录表增加对应 `PERMISSIVE` policy。没有 tenant context 时默认拒绝。
- `seed.ts` 在单个事务内先 `SET LOCAL ROLE enterprise_agent_provisioner`，再设置 transaction-local `app.tenant_id`，并使用 upsert 保证重复执行。当前 migration 执行身份会获得该 NOLOGIN 角色的 membership，以支持本地初始化。
- API readiness 会在应用角色下验证关键表、FORCE RLS、tenant policy 和缺失 tenant context 时的默认拒绝；真实数据库测试另外覆盖 15 张表的 RESTRICTIVE policy、关键角色越权、migration 元数据拒绝、消息触发器负例、跨租户复合外键、会话并发复用、消息幂等、离开成员恢复和 `lastMessageAt` 单调性。逐表逐动作完整授权矩阵与目标云数据库能力仍属于下方部署验证门槛。

生产环境不能照搬本地单连接：API 登录只能获得 `enterprise_agent_app` membership；provisioning 登录应通过受控基础设施单独获得 `enterprise_agent_provisioner` membership；migration 凭据不得提供给应用进程。目标 Managed PostgreSQL 仍需验证角色创建与 `SET ROLE` 能力。

## 原因

这些约束把常见的应用错误转化为数据库拒绝：漏写 tenant 条件、错误父资源 ID、绕过 HTTP Service 的消息写入、错误使用超级用户连接、未来 policy 组合错误。受限 NOLOGIN 角色也让本地 Docker 的超级用户连接可以在同一套代码路径中真实验证 RLS，而不是得到假阳性。

## 后果

- 新业务表不能依赖默认权限，必须在审阅过的 migration 中显式授权并加入 RLS 测试。
- 新后台 Worker 需要独立角色、policy 和最小权限，不能复用 API 或 provisioner 凭据。
- 业务关系的 migration 更复杂；修改主键关系时必须同时维护 Prisma schema、复合候选键和数据库约束。
- 软删除/离开会话时需要保持参与者和 sender 触发器语义一致。
- Managed PostgreSQL 上线前必须验证角色创建、membership、`SET ROLE`、RLS 和 migration 权限是否符合目标地域实例能力。

## 验证门槛

- 缺少、错误和正确 tenant context 的真实数据库测试；
- 超级用户 session 降权后的 `current_user` 和 `rolbypassrls` 断言；
- 跨租户复合外键 INSERT 负例；
- direct 会话并发复用、消息幂等、sender 参与者触发器和 `lastMessageAt` 单调性；
- migrate 后 seed 连续运行两次；
- 应用角色不能访问 `_prisma_migrations`，也不能写租户/组织/人员目录。
