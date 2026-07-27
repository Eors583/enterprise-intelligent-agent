# 企业 AI 协同平台 API

NestJS 模块化单体 API，当前提供首方认证、动态组织/成员管理、知识库治理、桌面 bootstrap、direct 会话、消息账本和可靠 IM Outbox。

认证、管理和持久化业务都要求 `REPOSITORY_DRIVER=prisma`。内存 Repository 只用于界面和单元测试，不支持真实登录或管理数据，生产环境会拒绝内存模式。

## 接口清单

### 健康检查

- `GET /health/live`：进程存活；
- `GET /health/ready`：Repository 就绪，并检查普通应用数据库安全基线。

### 认证

| 方法 | 路径                           | 认证                              | 说明                                                |
| ---- | ------------------------------ | --------------------------------- | --------------------------------------------------- |
| POST | `/api/v1/auth/register-tenant` | 公开、受 `REGISTRATION_MODE` 控制 | 原子创建企业、组织、根部门、OWNER、凭据、任职和会话 |
| POST | `/api/v1/auth/login`           | 公开                              | 企业短地址 + 邮箱 + 密码登录                        |
| POST | `/api/v1/auth/refresh`         | 公开，需 refresh token            | 轮换 access/refresh token                           |
| GET  | `/api/v1/auth/me`              | Bearer                            | 返回当前会话账号                                    |
| POST | `/api/v1/auth/logout`          | Bearer                            | 吊销当前会话，返回 204                              |

注册只表示创建新企业。既有企业成员不通过公共注册加入，而由管理后台创建。

### 组织与成员管理

| 方法   | 路径                                              | 说明                             |
| ------ | ------------------------------------------------- | -------------------------------- |
| GET    | `/api/v1/admin/organization`                      | 企业、部门和成员管理快照         |
| PATCH  | `/api/v1/admin/organization`                      | 修改企业名称、法定名称或时区     |
| POST   | `/api/v1/admin/org-units`                         | 创建部门                         |
| PATCH  | `/api/v1/admin/org-units/:id`                     | 修改名称、排序或父部门           |
| DELETE | `/api/v1/admin/org-units/:id?expectedVersion=...` | 软归档部门                       |
| POST   | `/api/v1/admin/members`                           | 创建成员、初始密码和任职         |
| PATCH  | `/api/v1/admin/members/:id`                       | 修改成员、角色、状态、部门或职位 |

部门移动同时经过服务层祖先链检查和数据库防环 trigger。归档部门前必须清理活跃子部门、未终止任职、岗位和知识库范围。企业/部门更新使用 `expectedVersion` 乐观锁。

`OWNER`、`ADMIN` 可修改组织和成员；`KNOWLEDGE_ADMIN` 只能读取组织快照以配置知识范围；`MEMBER` 无管理权限。只有 `OWNER` 能授予或管理 `OWNER`，且系统拒绝移除最后一个有效所有者。成员被设为 `INACTIVE` 或 `LOCKED` 时会吊销其全部会话。

### 知识库管理

| 方法   | 路径                                                                                       | 说明                     |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------ |
| GET    | `/api/v1/admin/knowledge-bases`                                                            | 知识库与文档列表         |
| POST   | `/api/v1/admin/knowledge-bases`                                                            | 创建知识库和部门范围     |
| PATCH  | `/api/v1/admin/knowledge-bases/:id`                                                        | 修改资料、状态和部门范围 |
| POST   | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/documents`                                 | 创建文档                 |
| PATCH  | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/documents/:documentId`                     | 更新文档和版本           |
| DELETE | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/documents/:documentId?expectedVersion=...` | 软归档文档               |

`OWNER`、`ADMIN`、`KNOWLEDGE_ADMIN` 可管理知识库。知识库支持 `DRAFT/ACTIVE/ARCHIVED`，文档支持 `DRAFT/READY/ARCHIVED`；文本更新会计算 SHA-256。当前没有文件上传、对象存储、解析、搜索、Embedding、向量索引或 RAG，部门范围也尚未被 Agent Runtime 消费。

### 桌面业务

- `GET /api/v1/bootstrap`：当前租户、用户、动态部门树、成员和 Agent 目录；
- `GET /api/v1/conversations`：当前用户的 direct 会话；
- `POST /api/v1/conversations`：创建或复用真人/Agent direct 会话；
- `GET /api/v1/conversations/:id/messages`：参与者可读的消息账本；
- `POST /api/v1/conversations/:id/messages`：按发送者和 `clientMessageId` 幂等写入文本消息。

消息、会话排序、Outbox 和 Audit 在同一事务提交。Agent 会话目前不会调用模型，用户文本入账不表示 AI 已回复。

## 认证实现

- 密码：带随机盐的 scrypt，数据库只保存版本化 hash；
- token：32 字节随机不透明 token，数据库只保存使用 `AUTH_TOKEN_PEPPER` 计算的 HMAC-SHA-256；
- 默认 TTL：access 900 秒，refresh 2,592,000 秒；
- refresh：原子轮换 token 对，保持原 `sessionId`；
- 鉴权：检查会话、租户和用户状态，并读取用户当前角色；
- 退出：设置 `revokedAt`；
- 登录错误统一，不暴露企业或邮箱是否存在。

全局 `AuthGuard` 默认保护所有非公开、非健康检查接口。开发兼容身份头只有 `ALLOW_DEV_IDENTITY_HEADERS=true` 时启用；生产不应开启。可信代理头是过渡边界，不替代 OIDC/SAML，也不会赋予管理角色。

MVP 尚未实现限流、MFA、邮箱验证、忘记密码、成员邀请、设备会话 UI 和登录安全事件审计。公网开放前必须补齐。

## Repository 与数据库连接

- `REPOSITORY_DRIVER=memory`：确定性进程内适配器，仅供开发/测试；
- `REPOSITORY_DRIVER=prisma`：真实 PostgreSQL 持久化，也是认证和管理功能的必需模式。

开发环境中专用 URL 可省略并回退 `DATABASE_URL`。生产 Prisma 模式必须配置不同数据库用户名：

| 环境变量              | 事务能力角色              | 用途                           |
| --------------------- | ------------------------- | ------------------------------ |
| `DATABASE_URL`        | `enterprise_agent_app`    | 普通桌面业务                   |
| `AUTH_DATABASE_URL`   | `enterprise_agent_auth`   | 身份发现、注册和会话           |
| `ADMIN_DATABASE_URL`  | `enterprise_agent_admin`  | 当前租户的组织、成员和知识写入 |
| `OUTBOX_DATABASE_URL` | `enterprise_agent_outbox` | 启用 Worker 时领取和更新队列   |

运行时登录不能是 superuser，不能拥有 `BYPASSRLS`。Migration 使用独立发布身份。普通和管理事务都使用 `SET LOCAL ROLE` 与 transaction-local `app.tenant_id`，禁止使用连接级 tenant setting。

## 数据库迁移

| Migration                                   | 作用                                       |
| ------------------------------------------- | ------------------------------------------ |
| `20260715000100_initial`                    | 基础 schema、RLS 和初始应用角色            |
| `20260715000200_tenant_scoped_foreign_keys` | 复合租户候选键和跨租户外键约束             |
| `20260715000300_security_policies`          | 限制性租户策略、最小权限和消息参与者约束   |
| `20260715000400_im_outbox_delivery`         | Outbox 租约、回执和专用 Worker 角色        |
| `20260715000500_im_delivery_unknown`        | 不确定投递状态和安全重试边界               |
| `20260715000600_auth_admin_knowledge`       | 首方认证、会话、角色、可编辑组织树和知识库 |

006 新增：

- `TenantRole`、`OrgUnitStatus`、知识状态枚举；
- `password_credentials`、`auth_sessions`；
- 组织/部门乐观锁版本；
- `knowledge_bases`、`knowledge_base_org_units`、`knowledge_documents`；
- 组织树防环 trigger；
- `enterprise_agent_auth`、`enterprise_agent_admin` 的 GRANT 和 RLS 策略。

历史 migration 已冻结；任何后续 schema 变化必须新增 migration。

## 审计与并发语义

企业注册写入 `auth.tenant_registered`。组织、部门、成员、知识库和知识文档的创建/更新/归档都会在业务事务内写 `AuditEvent`。

组织、部门、知识库和文档使用乐观锁；版本冲突返回 409。跨租户资源与不存在资源统一为 404。部门和知识文档采用软归档，不做物理删除。

当前尚无审计查询 UI、审计导出、不可变外部归档或 SIEM 推送。

## IM Outbox 与 Provider

`IM_OUTBOX_ENABLED=true` 启动 Worker。它使用 `FOR UPDATE SKIP LOCKED` 原子领取、租约、指数退避和抖动重试，并持久化 Provider 回执：

- `PUBLISHED`：明确接受或明确跳过；
- `FAILED`：确定失败；
- `UNKNOWN`：可能已经成功但无法安全重试，需要回调或人工对账。

Provider：

- `IM_PROVIDER=local`：开发/测试 sink，生产启用 Worker 时禁止；
- `IM_PROVIDER=tencent`：需要 SDKAppID、管理员账号和 Secret，UserSig 只在服务端生成。

腾讯账号导入、回调 Inbox 和真实公网凭据验收仍未完成。桌面同步当前依赖可见性自适应轮询，而非腾讯客户端 SDK/WebSocket。

## 本地运行

从仓库根目录：

```powershell
Copy-Item .env.example .env
# 把 REPOSITORY_DRIVER 改为 prisma
pnpm dev:infra
pnpm db:validate
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev:api
```

本地 seed：

- 企业短地址：`future-collaboration`；
- OWNER：`lin.xiao@example.local`；
- ADMIN：`zhou.rui@example.local`；
- MEMBER：`chen.yao@example.local`；
- 统一开发密码：`DevPassword!2026`。

仅用于本地，禁止用于生产。

## 检查命令

```powershell
pnpm --filter @enterprise/contracts build
pnpm --filter @enterprise/api typecheck
pnpm --filter @enterprise/api test
pnpm --filter @enterprise/api test:e2e
pnpm --filter @enterprise/api build
pnpm --filter @enterprise/api test:db
```

数据库测试用于验证 RLS 默认拒绝、跨租户隔离、复合外键、角色越权负例、会话/认证边界、组织树约束、Outbox 并发和消息幂等。完整架构和 MVP 边界见 [ADR-0005](../../docs/adr/0005-first-party-auth-admin-and-knowledge-governance.md)。
