# 企业 AI 协同平台

面向企业内部协作的桌面应用、管理后台和后端工程。当前版本已经形成一条真实可运行的 MVP 闭环：用户可以创建企业或登录，在 Electron 桌面端安全保存并切换多个账号，读取动态组织目录，创建/复用真人或智能体 direct 会话并发送消息；管理员可以在独立后台维护组织树、成员账号、角色、任职和知识库。

当前仍是开发版本，不是生产版。单智能体回答、Agent Run、文件摄取、可信引用和权限内检索已形成可运行链路；Embedding、pgvector 混合召回和 Reranker 已实现为可选能力，但默认关闭，必须配置真实供应商并通过企业问题集评估后才能作为语义 RAG 启用。未配置或供应商不可用时，界面会明确标记为“仅词法检索”，不会把关键词 + trigram 宣称为企业级语义检索。

详细边界见 [ADR-0005：首方认证、动态组织管理与知识库治理闭环](./docs/adr/0005-first-party-auth-admin-and-knowledge-governance.md)。

## 已实现能力

- 首方企业注册、邮箱密码登录、access/refresh token 轮换、退出和会话吊销；
- Electron Main + `safeStorage` 的 refresh token 加密、多账号保存和切换；
- 独立 React/Vite 管理后台；
- 动态组织树的创建、改名、排序、移动和归档；
- 成员账号、角色、状态、部门和职位管理；
- 知识库、部门范围、PDF/DOCX/TXT/Markdown 上传解析、切片、版本、发布/回滚和软归档；
- 可选 OpenAI-compatible Embedding、pgvector 精确/受控 HNSW 向量召回、RRF 融合及 Cohere-compatible Reranker；
- 权限过滤后的知识引用、管理员检索测试与历史 READY 版本向量重建；
- PostgreSQL `FORCE RLS`、租户复合外键和职责分离数据库角色；
- direct 会话、消息幂等、Outbox/Audit 同事务、可靠 Worker；
- Local IM Provider 和腾讯云单聊 outbound adapter；
- Agent Run 持久化、AI Runtime 调用、支持的驱动执行供应商确认取消、重试/对账、可信使用量回写和异常状态处理；
- 租户并发、分钟速率、月度 Token 配额、Owner 配额编辑，以及 Agent Run Runtime 可信上报的 Token/成本/执行延迟统计；
- 持久化登录失败限速、首次登录强制改密、管理员重置密码与会话吊销；
- 枚举安全的忘记密码请求、一次性密码重置、成员邀请/重发/状态跟踪与接受邀请；邮件发送仍是 best-effort，尚未进入可恢复的持久 Outbox；
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

2026-07-22 最新隔离复验：27 个 migration 在 `enterprise_agent_third_batch_acceptance` 全量部署；PostgreSQL 集成测试 7 文件、60/60 项通过，JavaScript/TypeScript 406 项、AI Runtime 130 项、语义验收工具离线回归 27 项、PowerShell 运维回归 8 个 suite/119 个断言通过。一次真实 custom archive 恢复演练的 17/17 项门禁全部通过，`cleanupVerified=true`，备份 SHA-256 为 `e91c829b62438a33178ec2585ece4bd4e267b8e8f3bb8eba043755632c4e5707`。中间一次测试调用暴露出角色连接 URL 可能混入根 `.env` 的风险；最终测试运行器已把普通、认证、管理和 Outbox 四个角色 URL 全部强制派生到 `TEST_DATABASE_URL`，两个受保护的既有验收库从未建立连接。指定模型但知识切片为零时，核心探针现在返回 `not_ready` / `insufficient_evidence` 和退出码 `2`，不再把 SQL 空集合判为真实向量覆盖。离线语义回归没有访问真实供应商，也不等同于企业问题集效果验收；真实供应商效果、可恢复邮件投递和生产运维接线仍未关闭，因此 V1 维持 **No-Go**。详情见[第三批复验记录](./docs/试点产品路线与第一批验收.md#7-第三批实施与复验状态2026-07-22)。

Migration 依次建立基础 schema、复合租户外键、RLS/最小权限、可靠 Outbox、首方认证、组织与知识模型、Agent Run、知识摄取与反馈、语义向量、租户用量治理、登录失败限速及账号恢复/邀请。不要修改已经执行的历史 migration；新变更必须增加新 migration。

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

API 开发 watch 现在输出到 `.nest-dev`，生产构建仍输出到 `dist`，并有自动化回归验证生产构建期间影子 watch 持续存活。变更前已经启动的旧 watch 进程不会热切换输出目录，需要等它下一次正常启动后才会使用新配置；本批没有为此手动重启当前开发服务。

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
- 管理后台当前把会话保存在标签页 `sessionStorage`，适合受控内网 MVP，公网部署需升级为 BFF/HttpOnly Cookie；
- API 默认要求 Bearer 会话；开发身份请求头只有 `ALLOW_DEV_IDENTITY_HEADERS=true` 时才可用；
- 密码使用带随机盐的 scrypt，不透明 token 在数据库只保存带 pepper 的 HMAC-SHA-256；
- 普通业务、认证、管理、provisioning 和 Outbox 分别使用数据库能力角色；
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
- `OUTBOX_DATABASE_URL`：启用 Worker 时的专用登录。

这些 URL 必须使用职责匹配的不同数据库用户名。运行时登录不能是 superuser，也不能拥有 `BYPASSRLS`；migration 使用独立发布身份。

## MVP 边界和下一步

当前尚未完成或仍需生产验收：

- 忘记密码与一次性成员邀请链路已经实现；恢复/邀请邮件目前仍是进程内 best-effort 投递，原始一次性令牌不会持久化，因此进程中断后不能由 Outbox 自动重放。生产前仍需持久化投递/重试闭环，以及 OIDC/SAML、SCIM、MFA 和设备会话管理；
- 可信代理边界、WAF/设备级限速、限速表独立过期清理与生产告警投递；
- 群聊、消息分页、已读/撤回、富媒体、WebSocket 和系统通知；
- 腾讯账号 provisioning、回调 Inbox 和真实公网凭据验收；
- 对象存储、OCR、真实 Embedding/Reranker 供应商验收、中文企业问题集效果门禁与大规模向量召回容量验证；
- 覆盖生成、Embedding、Reranker 的统一用量账本，以及不可变模型价格版本、币种和部门预算；
- AI Runtime 的 PostgreSQL RunStore、服务间认证与多实例执行租约；当前内存 RunStore 被生产启动门禁禁止，不能作为真实部署路径；
- 流式回复、完整模型降级路由、工具调用与高风险操作审批；
- 对没有可确认取消协议的通用 Chat Completions 供应商实现真正的“停止生成”；
- Windows 生产计划任务以 `SYSTEM` 身份的实际注册与权限验收、自动备份/恢复调度、加密异地存储、告警通道接线、全链路监控、高可用、自动更新和代码签名闭环。

RAG 必须先完成受控摄取和版本快照，再建立索引流水线，随后把租户、知识库状态、文档状态和组织范围过滤放进检索查询本身。详细路线见 [ADR-0005](./docs/adr/0005-first-party-auth-admin-and-knowledge-governance.md#11-后续-rag-实施路线)。

## 文档

- [项目文档索引](./docs/README.md)
- [企业 AI 协同平台总体技术方案](./docs/企业AI协同平台-总体技术方案.md)
- [本地开发与数据库验证](./docs/runbooks/本地开发与数据库验证.md)
- [API 操作说明](./apps/api/README.md)
- [管理后台操作说明](./apps/admin/README.md)
- [桌面端操作说明](./apps/desktop/README.md)
