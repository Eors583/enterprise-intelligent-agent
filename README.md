# 企业 AI 协同平台

面向企业内部协作的桌面应用、管理后台和后端工程。当前仓库已经形成从企业身份、组织与角色任命，到价值/战略/目标/任务、流程协同、Agent Run、Tool Gateway、知识/记忆/经验、评测与 FinOps 的 V2 工程闭环；员工可在 Electron 桌面端进入角色与任务工作台，管理员可在独立后台治理组织、智能体、知识、模型、身份、审计和成本。

当前仍是开发版本，不是生产版。单智能体回答、流式 Agent Run、文件摄取、可信引用和权限内检索已形成代码链路；Embedding、pgvector 混合召回和 Reranker 已实现为可选能力，但默认关闭，必须配置真实供应商并通过非空知识切片和企业问题集评估后才能作为语义 RAG 启用。未配置或供应商不可用时，界面会明确标记为“仅词法检索”，不会把关键词 + trigram 宣称为企业级语义检索。

当前实现、验收状态与生产边界以 [BMS-AI V2 实施计划](./docs/BMS-AI_V2_实施计划.md) 和 [BMS-AI V2 验收矩阵](./docs/BMS-AI_V2_验收矩阵.md) 为准；原始认证与知识库决策见 [ADR-0005](./docs/adr/0005-first-party-auth-admin-and-knowledge-governance.md)。

## 已实现能力

- 首方企业注册、邮箱密码登录、access/refresh token 轮换、退出和会话吊销；
- Electron Main + `safeStorage` 的 refresh token 加密、多账号保存和切换；
- 独立 React/Vite 管理后台；
- 动态组织树的创建、改名、排序、移动和归档；
- 成员账号、角色、状态、部门和职位管理；
- 知识库、部门范围、PDF/DOCX/XLSX/TXT/Markdown 上传解析、切片、版本、发布/回滚和软归档；
- 可选 OpenAI-compatible Embedding、pgvector 精确/受控 HNSW 向量召回、RRF 融合及 Cohere-compatible Reranker；
- 权限过滤后的知识引用、管理员检索测试与历史 READY 版本向量重建；
- 结构化 Role Blueprint、版本评审/发布/回滚，以及多人、多角色、临时、代理和交接任命；
- Value→Strategy→Objective→Task→Process→Deliverable→Evidence 企业语义主链；
- 版本化流程、业务事件、结构化协同、纠偏反馈、补偿、DLQ 和人工接管；
- Tool Registry/Gateway、动作风险分级、dry-run、幂等、确认/审批、UNKNOWN 对账与补偿；
- 企业/角色/员工/任务/会话五层记忆，以及经验候选、脱敏、复核、发布、投影和退休；
- 版本化 AI 评测集、坏例回流、运行证明、发布门禁和管理端治理；
- 知识本体/谓词、实体合并、时态、冲突与人工校正治理；
- 员工角色/任务/协同/工具/记忆/经验工作台，以及管理总览；
- PostgreSQL `FORCE RLS`、租户复合外键和职责分离数据库角色；
- direct 会话、消息幂等、Outbox/Audit 同事务、可靠 Worker；
- Local IM Provider 和腾讯云单聊 outbound adapter；
- Agent Run 持久化、AI Runtime 调用、支持的驱动执行供应商确认取消、重试/对账、可信使用量回写和异常状态处理；
- 租户并发、分钟速率、月度 Token 配额、Owner 配额编辑，以及 Agent Run Runtime 可信上报的 Token/成本/执行延迟统计；
- 持久化登录失败限速、首次登录强制改密、管理员重置密码与会话吊销；
- 枚举安全的忘记密码请求、一次性密码重置、成员邀请/重发/状态跟踪与接受邀请；邮件发送仍是 best-effort，尚未进入可恢复的持久 Outbox；
- TOTP MFA、设备会话、Refresh Family、OIDC/SAML/SCIM 管理面和身份安全审计；
- 模型价格/预算、AI 与人工成本、成本分摊、收益/ROI、预警、路由建议和独立成本复核；
- 租户内审计检索、受控导出、SHA-256 追加链完整性复算和 OpenTelemetry 接线；
- 可校验数据库备份、隔离恢复演练和核心告警探针；
- API 开发 watch 与生产构建使用独立输出目录，避免生产构建清理 `dist` 时中断开发 watch。

## 目录

```text
apps/
├── api/                 # NestJS 模块化单体 API
├── admin/               # React + Vite 企业管理后台
└── desktop/             # Electron + React 桌面端
services/
└── ai-runtime/          # Python FastAPI Agent Runtime
packages/
├── contracts/           # Zod + TypeScript 共享契约
└── tsconfig/            # TypeScript 基础配置
infra/                   # 本地 PostgreSQL/Redis
docs/                    # 总体方案、ADR 和运行手册
```

## 环境要求

- Node.js 24.x
- pnpm 11.x
- Python 3.12+
- Docker Desktop（启动 PostgreSQL/Redis 时需要）

## 首次安装

```powershell
Copy-Item .env.example .env
pnpm install
pnpm setup:electron

python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".\services\ai-runtime[dev]"
```

Electron npm 包不自动下载桌面运行时，`pnpm setup:electron` 是必需步骤。如果无法访问 GitHub Release，可临时使用镜像；下载结果仍按 Electron 官方 SHA-256 清单校验：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
pnpm setup:electron
Remove-Item Env:ELECTRON_MIRROR
```

## 初始化真实数据库

认证、账号切换、组织管理和知识库都要求 Prisma 模式。将根 `.env` 设置为：

```dotenv
REPOSITORY_DRIVER=prisma
REGISTRATION_MODE=open
ALLOW_DEV_IDENTITY_HEADERS=false
AUTH_TOKEN_PEPPER=replace-with-at-least-32-random-characters
```

然后运行：

```powershell
pnpm dev:infra
pnpm db:migrate
pnpm db:seed
pnpm test:db
```

Migration 依次建立基础 schema、复合租户外键、RLS/最小权限、可靠 Outbox、首方认证、组织与知识模型、Agent Run、知识摄取与反馈、语义向量、租户用量治理、V2 经营与协同域、企业身份、审计、FinOps 和运行治理。不要修改已经执行的历史 migration；新变更必须增加新 migration。

迁移数量和测试通过数字不在 README 中写死。每个候选版本都必须重新在一个全新独立数据库执行完整迁移、重复 seed、PostgreSQL/RLS/ACL 集成测试、备份恢复门禁和全仓质量检查；仓库内模拟或空集合探针不能替代真实外部供应商与业务问题集验收。在这些总门禁完成前，整体状态保持 **No-Go**。

本地 seed 登录信息：

| 企业短地址             | 邮箱                     | 角色   | 密码               |
| ---------------------- | ------------------------ | ------ | ------------------ |
| `future-collaboration` | `lin.xiao@example.local` | OWNER  | `DevPassword!2026` |
| `future-collaboration` | `zhou.rui@example.local` | ADMIN  | `DevPassword!2026` |
| `future-collaboration` | `chen.yao@example.local` | MEMBER | `DevPassword!2026` |

这些账号和密码只能用于本地开发，禁止进入生产环境。

## 启动

激活 Python 虚拟环境后，一次启动 API、AI Runtime、管理后台和桌面端：

```powershell
pnpm dev
```

也可分别启动：

```powershell
pnpm dev:api       # http://127.0.0.1:3000
pnpm dev:ai        # http://127.0.0.1:8100
pnpm dev:admin     # http://127.0.0.1:4173
pnpm dev:desktop
```

API 开发 watch 输出到 `.nest-dev`，生产构建输出到 `dist`，避免构建过程覆盖正在运行的开发产物。

关键检查地址：

- API 存活：`GET http://127.0.0.1:3000/health/live`
- API 就绪：`GET http://127.0.0.1:3000/health/ready`
- 管理后台：`http://127.0.0.1:4173`
- AI Runtime 存活：`GET http://127.0.0.1:8100/health/live`
- AI Runtime 文档：`http://127.0.0.1:8100/internal/docs`

桌面端和管理后台都可使用“创建企业”生成新的独立租户；生产环境应关闭开放注册并改为受控开通流程。

## 质量检查

```powershell
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

数据库检查：

```powershell
pnpm db:validate
pnpm db:generate
pnpm test:db
```

## 当前安全边界

- Electron Renderer 无 Node.js、文件系统或 Shell 权限，只能调用窄化 Preload IPC；
- 桌面 access token 仅存在 Main 内存，refresh token 使用系统 `safeStorage` 加密；
- 管理后台通过同源 BFF 使用 `HttpOnly`、`Secure`（生产）和 `SameSite=Strict` Cookie；前端内存只保存非敏感账号摘要，旧版 Web Storage 中的 token 只会被丢弃，不会继续使用；
- API 默认要求 Bearer 会话；开发身份请求头只有 `ALLOW_DEV_IDENTITY_HEADERS=true` 时才可用；
- 密码使用带随机盐的 scrypt，不透明 token 在数据库只保存带 pepper 的 HMAC-SHA-256；
- 普通业务、认证、管理、任命生命周期、provisioning、Outbox 和 AI Runtime
  分别使用数据库能力角色；
- 普通与管理事务先 `SET LOCAL ROLE`，再设置 transaction-local `app.tenant_id`；
- 租户表使用应用 tenant 条件、复合外键和 PostgreSQL `FORCE RLS` 多层隔离；
- 管理写操作与 Audit 同事务；组织/知识更新使用乐观锁，删除采用软归档；
- 会话写入、消息、Outbox 和 Audit 同事务，消息使用 `clientMessageId` 幂等；
- Outbox Worker 使用 `SKIP LOCKED`、租约和退避重试；不确定投递进入 `UNKNOWN`，不会盲目重发；
- 腾讯 Secret/UserSig 只存在后端，桌面端尚未嵌入腾讯客户端 SDK；
- AI Runtime 默认不访问外部供应商；回答、Embedding 和 Reranker 使用彼此独立的驱动与密钥配置，未通过 readiness 时不得把智能体标记为模型可用；
- 登录与恢复限速表只保存 tenant/email/IP 或不透明令牌的带 pepper HMAC，不保存原始标识，且仅认证数据库角色可访问；生产强制启用跨租户全局网络桶，缺失客户端地址进入固定 fail-closed 桶。网络桶会在随机账户/令牌桶之前检查，每个 scope 有事务串行准入的硬容量上限，计数采用饱和增长；
- Agent Run 在租户 advisory lock 下原子检查、预留并结算配额；生成输入按知识优先、历史由新到旧执行保守 UTF-8 预算化组装，并由 API 与 Runtime 两层预检。该估算器不是模型 tokenizer；供应商未返回可信使用量时不会把缺失值伪装成零，也不会提前释放保守 Token 占位；UNKNOWN 在可信对账改变状态前始终计入执行并发。

生产 Prisma 模式必须分别提供：

- `DATABASE_URL`：普通 API 登录；
- `AUTH_DATABASE_URL`：认证登录；
- `ADMIN_DATABASE_URL`：管理登录；
- `LIFECYCLE_DATABASE_URL`：角色任命定时生效、过期、代理和交接回收的专用登录；
- `OUTBOX_DATABASE_URL`：启用 Worker 时的专用登录。

这些 URL 必须使用职责匹配的不同数据库用户名。运行时登录不能是 superuser，也不能拥有 `BYPASSRLS`；migration 使用独立发布身份。

## MVP 边界和下一步

当前尚未完成或仍需总门禁/生产验收：

- 忘记密码、一次性成员邀请、MFA、设备会话、OIDC/SAML/SCIM 管理面已经实现；恢复/邀请邮件仍是 best-effort，且真实 IdP 签名、元数据和 SCIM 兼容性必须联网验收；
- 可信代理边界、WAF/设备级限速、限速表独立过期清理与生产告警投递；
- 群聊、消息分页、已读/撤回、富媒体、WebSocket 和系统通知；
- 腾讯账号 provisioning、回调 Inbox 和真实公网凭据验收；
- 生产对象存储/KMS/病毒扫描/高级 OCR 与文档解析器接线，真实 Embedding/Reranker 供应商验收、中文企业问题集效果门禁与大规模向量召回容量验证；
- 生成、Embedding、Reranker 的供应商账单核对，以及价格/币种/预算/收益的业务 Owner 验收；
- AI Runtime 已具备 PostgreSQL RunStore 和 Bearer 服务认证；仍需完成多实例执行租约、
  Runtime Outbox/Inbox、mTLS 与供应商级熔断后才能作为生产执行底座；
- 模型降级与流式断线恢复的真实供应商故障演练，以及 Tool Gateway 生产业务适配器和高风险审批 UAT；
- 对没有可确认取消协议的通用 Chat Completions 供应商实现真正的“停止生成”；
- 全新数据库迁移/RLS/ACL/恢复总门禁、全仓回归和浏览器 UAT；
- Windows 生产计划任务以 `SYSTEM` 身份的实际注册与权限验收、自动备份/恢复调度、加密异地存储、PITR、告警/SIEM/OTLP 接线、高可用、自动更新和代码签名闭环。

RAG 必须先完成受控摄取和版本快照，再建立索引流水线，随后把租户、知识库状态、文档状态和组织范围过滤放进检索查询本身。详细路线见 [ADR-0005](./docs/adr/0005-first-party-auth-admin-and-knowledge-governance.md#11-后续-rag-实施路线)。

## 文档

- [项目文档索引](./docs/README.md)
- [企业 AI 协同平台总体技术方案](./docs/企业AI协同平台-总体技术方案.md)
- [本地开发与数据库验证](./docs/runbooks/本地开发与数据库验证.md)
- [API 操作说明](./apps/api/README.md)
- [管理后台操作说明](./apps/admin/README.md)
- [桌面端操作说明](./apps/desktop/README.md)
