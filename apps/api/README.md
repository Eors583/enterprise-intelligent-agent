# 企业 AI 协同平台 API

NestJS 模块化单体 API。除首方认证、组织/成员、知识库、会话和可靠 Outbox 外，当前还承载
角色蓝图与任命、企业语义主链、流程与结构化协同、Tool Gateway、五层记忆、经验治理、
AI 评测、模型路由、企业身份、审计、FinOps 和管理总览。各域通过明确 module、共享契约及
数据库能力角色隔离；模型 Runtime 不是流程、权限、预算或组织主数据的权威来源。

认证、管理和持久化业务都要求 `REPOSITORY_DRIVER=prisma`。内存 Repository 只用于界面和单元测试，不支持真实登录或管理数据，生产环境会拒绝内存模式。

## 接口清单

### 健康检查

- `GET /health/live`：进程存活；
- `GET /health/ready`：Repository、必需的 AI Runtime/OpenTelemetry 以及生产知识入库消费者就绪；生产开启持久化知识写入后，Worker 至少成功轮询一次队列才会返回 `checks.knowledgeIngestion=up`。

所有 HTTP 响应都会返回 `X-Request-ID`、`X-Correlation-ID` 与 W3C `traceparent`。访问日志采用脱敏单行 JSON，只记录关联标识、方法、无 query 的 path、状态码和耗时；跨进程调用继续传播 correlation ID，生产 Trace exporter 的接线边界见 `docs/runbooks/生产可观测性与灾备验收.md`。

### 认证

| 方法 | 路径                               | 认证                              | 说明                                                |
| ---- | ---------------------------------- | --------------------------------- | --------------------------------------------------- |
| POST | `/api/v1/auth/register-tenant`     | 公开、受 `REGISTRATION_MODE` 控制 | 原子创建企业、组织、根部门、OWNER、凭据、任职和会话 |
| POST | `/api/v1/auth/login`               | 公开                              | 企业短地址 + 邮箱 + 密码登录                        |
| POST | `/api/v1/auth/refresh`             | 公开，需 refresh token            | 轮换 access/refresh token                           |
| POST | `/api/v1/auth/password-reset/*`    | 公开、受枚举安全和持久化限速保护  | 请求并完成一次性密码恢复                            |
| POST | `/api/v1/auth/invitations/accept`  | 公开、受持久化限速保护            | 接受一次性成员邀请并设置密码                        |
| GET  | `/api/v1/auth/me`                  | Bearer                            | 返回当前会话账号                                    |
| GET  | `/api/v1/auth/mfa`                 | Bearer                            | 查看 MFA 状态                                       |
| POST | `/api/v1/auth/mfa/*`               | Bearer/登录挑战                   | TOTP 注册、验证和近期认证                           |
| POST | `/api/v1/auth/logout`              | Bearer                            | 吊销当前会话，返回 204                              |
| POST | `/api/v1/auth/browser/{login,...}` | HttpOnly Cookie                   | 管理端 BFF 会话登录、刷新和退出                     |

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
| POST   | `/api/v1/admin/member-invitations`                | 通过一次性邀请创建本地成员       |
| POST   | `/api/v1/admin/members/:id/invitation`            | 激活无密码凭据的飞书目录成员     |
| POST   | `/api/v1/admin/members/:id/invitation/resend`     | 撤销并重发未使用的一次性邀请     |
| PATCH  | `/api/v1/admin/members/:id`                       | 修改成员、角色、状态、部门或职位 |

部门移动同时经过服务层祖先链检查和数据库防环 trigger。归档部门前必须清理活跃子部门、未终止任职、岗位和知识库范围。企业/部门更新使用 `expectedVersion` 乐观锁。

`OWNER`、`ADMIN` 可修改组织和成员；`KNOWLEDGE_ADMIN` 只能读取组织快照以配置知识范围；`MEMBER` 无管理权限。只有 `OWNER` 能授予或管理 `OWNER`，且系统拒绝移除最后一个有效所有者。成员被设为 `INACTIVE` 或 `LOCKED` 时会吊销其全部会话。

飞书同步成员默认没有本地密码凭据，不能使用部署级共享密码登录。管理员只能向其唯一有效工作邮箱签发一次性邀请，或由企业 SSO 完成激活；同步不会覆盖已有本地凭据。邮件发送成功时管理 API 不返回邀请令牌或 URL；仅当邮件未配置或投递失败时返回显式 `MANUAL_FALLBACK`，其链接采用独立短 TTL、只显示一次、消费后失效并写入管理员审计。

### 知识库管理

| 方法   | 路径                                                                                       | 说明                     |
| ------ | ------------------------------------------------------------------------------------------ | ------------------------ |
| GET    | `/api/v1/admin/knowledge-bases`                                                            | 知识库与文档列表         |
| POST   | `/api/v1/admin/knowledge-bases`                                                            | 创建知识库和部门范围     |
| PATCH  | `/api/v1/admin/knowledge-bases/:id`                                                        | 修改资料、状态和部门范围 |
| POST   | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/documents`                                 | 创建文档                 |
| POST   | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/documents/upload`                          | 上传并排队解析文件       |
| POST   | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/documents/import-web`                      | 受控导入网页             |
| PATCH  | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/documents/:documentId`                     | 更新文档和版本           |
| POST   | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/retrieval-test`                            | 权限内检索测试           |
| DELETE | `/api/v1/admin/knowledge-bases/:knowledgeBaseId/documents/:documentId?expectedVersion=...` | 软归档文档               |

`OWNER`、`ADMIN`、`KNOWLEDGE_ADMIN` 可管理知识库。知识库支持版本化文件/网页摄取、
解析质量复核、切片、发布/回滚、检索测试、原文引用、图谱治理和失败重试。受支持的本地解析
格式包括 PDF、DOCX、XLSX、TXT 和 Markdown；生产持久化写入必须同时启用并验证知识 Worker
readiness，消费者未就绪时在产生副作用前 fail-closed。

检索先执行租户、知识库状态、文档版本和组织/任务范围过滤，再做关键词、可选向量召回、
融合与 Reranker；生成后再次执行敏感信息和引用约束。未配置真实 Embedding/Reranker 或非空
向量覆盖不足时会明确降级为词法检索，不能据此宣称企业级语义 RAG 已通过。

### 桌面业务

- `GET /api/v1/bootstrap`：当前租户、用户、动态部门树、成员和 Agent 目录；
- `GET /api/v1/conversations`：当前用户的 direct 会话；
- `POST /api/v1/conversations`：创建或复用真人/Agent direct 会话；
- `GET /api/v1/conversations/:id/messages`：参与者可读的消息账本；
- `POST /api/v1/conversations/:id/messages`：按发送者和 `clientMessageId` 幂等写入文本消息。
- `GET /api/v1/conversations/:id/runs/:runId/events|stream`：按游标读取或 SSE 续传生成事件；
- `POST /api/v1/conversations/:id/runs/:runId/cancel|retry`：停止或固定原快照重新生成。

消息、Run、Outbox 和 Audit 在受控事务边界提交。Agent 消息会进入持久化 Run 队列，经
AI Runtime 和发布的模型路由生成回复；客户端展示排队、生成、停止、失败、UNKNOWN 和终态，
并用事件游标恢复断线。Runtime 或模型未通过 readiness 时 Agent 不得显示为可用。

## 认证实现

- 密码：带随机盐的 scrypt，数据库只保存版本化 hash；
- token：32 字节随机不透明 token，数据库只保存使用 `AUTH_TOKEN_PEPPER` 计算的 HMAC-SHA-256；
- 默认 TTL：access 900 秒，refresh 2,592,000 秒；
- refresh：原子轮换 token 对，保持原 `sessionId`；
- 鉴权：检查会话、租户和用户状态，并读取用户当前角色；
- 退出：设置 `revokedAt`；
- 登录错误统一，不暴露企业或邮箱是否存在。

全局 `AuthGuard` 默认保护所有非公开、非健康检查接口。开发兼容身份头只有 `ALLOW_DEV_IDENTITY_HEADERS=true` 时启用；生产不应开启。可信代理头是过渡边界，不替代 OIDC/SAML，也不会赋予管理角色。

已实现持久化登录/恢复限速、一次性邀请与重发、密码找回、管理员重置、TOTP MFA、设备会话、
Refresh Family、OIDC/SAML/SCIM 管理面和登录安全审计。邮件投递目前仍是 best-effort，
真实 OIDC/SAML 签名/元数据、SCIM IdP 兼容性、令牌运维和生产邮件 Outbox 必须在目标环境验收；
这些外部边界未通过前不能把企业身份标记为生产就绪。

## Repository 与数据库连接

- `REPOSITORY_DRIVER=memory`：确定性进程内适配器，仅供开发/测试；
- `REPOSITORY_DRIVER=prisma`：真实 PostgreSQL 持久化，也是认证和管理功能的必需模式。

开发环境中专用 URL 可省略并回退 `DATABASE_URL`。生产 Prisma 模式必须配置不同数据库用户名：

| 环境变量                 | 事务能力角色                 | 用途                                           |
| ------------------------ | ---------------------------- | ---------------------------------------------- |
| `DATABASE_URL`           | `enterprise_agent_app`       | 普通桌面业务                                   |
| `AUTH_DATABASE_URL`      | `enterprise_agent_auth`      | 身份发现、注册和会话                           |
| `ADMIN_DATABASE_URL`     | `enterprise_agent_admin`     | 当前租户的组织、成员和知识写入                 |
| `LIFECYCLE_DATABASE_URL` | `enterprise_agent_lifecycle` | 跨租户枚举后按租户处理任命生效、过期和权限回收 |
| `OUTBOX_DATABASE_URL`    | `enterprise_agent_outbox`    | 启用 Worker 时领取和更新队列                   |

这些生产 URL 必须使用互不相同的登录名。运行时登录不能是 superuser，不能拥有
`BYPASSRLS`。Migration 使用独立发布身份。所有租户事务都使用 `SET LOCAL ROLE` 与
transaction-local `app.tenant_id`，禁止使用连接级 tenant setting。

## 数据库迁移

迁移从基础多租户/RLS/认证/组织/知识模型逐步扩展到 Agent Run、向量检索、角色任命、
企业语义、流程协同、Tool Gateway、记忆经验、评测、营销/人力/组织/FinOps、企业身份、
流式事件、知识图谱治理和生产运维约束。新增租户表必须同时具备复合租户外键、
`ENABLE/FORCE RLS`、职责分离 ACL、审计/Outbox、恢复门禁和跨租户负向测试。

历史 migration 已冻结；任何后续 schema 变化必须新增 migration。迁移数量和通过状态以
空库 `prisma migrate deploy` 与恢复报告为准，不在本文写死易过期的数字。

## V2 领域边界

| 领域                | API 权威职责                                                                |
| ------------------- | --------------------------------------------------------------------------- |
| 角色与授权          | Blueprint/Version/Assignment/Instance、生命周期、默认拒绝授权和不可变快照   |
| 经营与流程          | 价值、战略、目标、任务、指标、证据、流程状态、业务事件和结构化协同          |
| Tool Gateway        | 注册、JSON Schema、组合身份、风险分级、确认/审批、幂等、回执、对账和补偿    |
| 知识、记忆与经验    | 摄取/版本/检索/引用、图谱治理、五层记忆、经验审核发布与知识投影             |
| AI 运行与评测       | Run/事件游标、模型路由、坏例回流、数据集/运行证明和发布门禁                 |
| 身份、审计与 FinOps | MFA/设备/OIDC/SAML/SCIM、哈希链审计、价格/预算/成本/收益/ROI 和独立成本复核 |

Tool Gateway 的供应商计量使用 `UNATTESTED`、`PROVIDER_ATTESTED` 和
`GATEWAY_ATTESTED` 区分缺失计量、供应商已证实费用与网关已证实零费用。缺失计量绝不以
`0` 表示；FinOps 只能使用已批准且生效的不可变价格快照独立结算，价格快照标识和版本进入
成本证据哈希。供应商已证实金额仍须与同一价格快照精确核对，不一致时阻断为
`SETTLEMENT_MISMATCH`。

Runtime 只执行 API 已固化并授权的 Run 快照；流程状态、任命、预算、审批、知识权限和成本
复核结果始终以 PostgreSQL 事务状态为准。新增域不能通过模型输出或前端状态绕开服务授权、
RLS、复合外键、Audit/Outbox、幂等和状态机 CAS。

## 审计与并发语义

企业注册写入 `auth.tenant_registered`。组织、部门、成员、知识库和知识文档的创建/更新/归档都会在业务事务内写 `AuditEvent`。

组织、部门、知识库和文档使用乐观锁；版本冲突返回 409。跨租户资源与不存在资源统一为 404。部门和知识文档采用软归档，不做物理删除。

管理端已提供租户内审计查询、数据库级 SHA-256 追加链完整性复算，以及仅企业所有者可执行的受控 CSV 导出。导出用途、筛选、记录数和文件哈希会再次写入审计链。外部不可变归档与 SIEM 投递仍需在部署环境配置目标连接器。

## OpenTelemetry

API 通过 OTLP/HTTP 输出 traces 与 metrics，并在加载 Nest、HTTP、Prisma 等模块前初始化自动埋点。生产环境默认把 OpenTelemetry 视为 readiness 必需能力；未配置 Collector、SDK 启动失败或被显式禁用时，进程可以保持存活用于诊断，但 `/health/ready` 会拒绝宣告就绪。

推荐通过服务端 Secret/ConfigMap 配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 和 `OTEL_EXPORTER_OTLP_HEADERS`。生产只接受 HTTPS Collector；本地开发可使用 localhost HTTP。采样比例通过 `OTEL_TRACES_SAMPLER_ARG` 控制，默认开发 100%、生产 10%。

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

## 当前验收状态

上述能力表示仓库内代码和定向回归边界，不等于生产验收。候选版本仍须在全新独立数据库
完成全部 migration、重复 seed、PostgreSQL/RLS/ACL 集成与隔离恢复演练，并通过全仓检查和
真实浏览器 UAT。真实模型/Embedding/Reranker、飞书、企业 IdP、邮件、OTLP/SIEM、异地加密
备份/PITR 和生产业务工具适配器必须分别留存外部验收证据；任一门禁未关闭时总体保持
`No-Go`。当前状态以 [BMS-AI V2 验收矩阵](../../docs/BMS-AI_V2_验收矩阵.md) 为准。
