# Codex 项目代码、测试与产品优化导航

> 更新日期：2026-08-17
> 适用范围：`enterprise-intelligent-agent` 整个仓库
> 目标读者：后续参与本项目开发、修复、测试、评审和产品优化的 AI 与工程人员

## 1. 这份导航怎么用

本文件是“去哪里改、改完测什么、如何判断产品是否真的可用”的稳定入口，不替代源代码、ADR、运行手册或验收矩阵。

开始任务时按以下顺序建立事实：

1. 阅读根目录 [`AGENTS.md`](../../AGENTS.md)，确认产品目标、架构边界和完成标准。
2. 阅读 [`AI开发接班长期记忆.md`](./AI开发接班长期记忆.md)，继承用户长期确认的协作偏好、产品取舍和验收标准；用户当前最新指令始终优先。
3. 查看 `git status --short`。当前工作区经常同时存在其他任务的未提交修改，禁止回滚、覆盖或格式化无关文件。
4. 阅读目标模块的相邻实现、契约、测试和最近 migration。
5. 用当前代码、Prisma schema、前向 migration 和可运行测试判断“已经实现什么”。
6. 用 [`BMS-AI_V2_验收矩阵.md`](../BMS-AI_V2_验收矩阵.md) 判断“是否已有足够证据宣称可用”。
7. 用 ADR 判断依赖方向和不可突破的边界；用 runbook 完成真实环境验证。
8. 最后再参考本目录下按日期记录的专题分析，它们是当时证据，不是永久真相。

### 1.1 状态判断的证据优先级

| 优先级 | 证据                                                                                                       | 用途                                   |
| ------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1      | 当前源代码、`schema.prisma`、最新 migration、测试                                                          | 判断当前工作树真实行为                 |
| 2      | [`BMS-AI_V2_实施计划.md`](../BMS-AI_V2_实施计划.md) 与 [`BMS-AI_V2_验收矩阵.md`](../BMS-AI_V2_验收矩阵.md) | 判断完成度、阻断项和验收等级           |
| 3      | [`docs/adr/`](../adr/)                                                                                     | 判断已批准的架构和安全边界             |
| 4      | [`docs/runbooks/`](../runbooks/)                                                                           | 判断真实部署、接线、恢复和外部验收方法 |
| 5      | 根 [`README.md`](../../README.md) 和各应用 README                                                          | 安装、启动和能力概览                   |
| 6      | [`docs/codex/`](./) 的日期文档                                                                             | 追溯某次问题、方案和验证记录           |

注意：当前 [`docs/README.md`](../README.md) 的“实现快照”已有部分内容落后于根 README 和代码，例如身份治理、知识摄取和 RAG 的描述。后续 AI 不得只引用该快照判断功能状态。

### 1.2 三种不同的“完成”

- **代码存在**：目录、页面、接口或模型已经写入仓库，不等于可以使用。
- **仓库门禁通过**：单元、契约、类型、构建或数据库测试通过，不等于外部系统和生产环境已验收。
- **生产可用**：真实模型、IM、身份、对象存储、知识基础设施、监控、备份和业务 UAT 均有可复验证据。

当前项目整体仍是开发候选版本；验收矩阵结论仍为 **No-Go**。页面存在、HTTP 200、任务已排队、测试用了 mock，都不能单独表述为“已上线”或“生产可用”。

## 2. 系统总览

```text
管理后台 React/Vite                 员工端 Electron/React
        │                                   │
        └────────────── HTTP/SSE/IM ────────┘
                            │
                     NestJS 企业业务 API
        ┌───────────────────┼────────────────────┐
        │                   │                    │
  PostgreSQL + RLS     Outbox / Worker      Tool / 外部适配器
        │                   │                    │
        └──────── Knowledge/Agent Gateway ──────┘
                            │
                   Python FastAPI AI Runtime
                            │
          模型 / Embedding / Rerank / Manus 等供应商
```

核心权威边界：

- NestJS API 是租户权限、组织、战略、项目任务、审批和业务状态的权威来源。
- PostgreSQL 是业务事实账本；租户数据依赖复合键、能力角色和 `FORCE RLS` 隔离。
- AI Runtime 只负责模型执行、Embedding 和 Rerank，不能绕过 API 权限。
- Tool Gateway 是智能体执行外部动作的唯一入口。
- 知识能力必须经公共 `KnowledgeGateway` / `KnowledgeRetrievalGateway`、公共 HTTP API或版本化知识事件使用。
- 外部系统通过适配器接入；业务代码不能直接绑定某个供应商。

## 3. 根目录地图

```text
enterprise-intelligent-agent/
├─ apps/
│  ├─ api/                         NestJS API、Prisma、Worker、集成测试
│  ├─ admin/                       React/Vite 管理后台
│  └─ desktop/                     Electron 员工端
├─ packages/
│  ├─ contracts/                   Zod + TypeScript 跨端契约
│  └─ tsconfig/                    TypeScript 公共配置
├─ services/
│  └─ ai-runtime/                  Python FastAPI AI 执行服务
├─ infra/                          Docker、监控、备份、恢复、运维脚本
├─ tools/
│  ├─ knowledge-smoke/             知识与 Agent 端到端验收工具
│  └─ semantic_acceptance/         语义检索离线/联网验收工具
├─ docs/
│  ├─ adr/                         已批准架构决策
│  ├─ codex/                       AI 专题记录与本导航
│  ├─ design-system/               管理后台设计规范
│  └─ runbooks/                    开发、接线、恢复和生产验收手册
├─ .env.example                    环境变量模板，不得写真实密钥
├─ package.json                    Monorepo 总命令
├─ pnpm-workspace.yaml             `apps/*`、`packages/*` 工作区
├─ turbo.json                      构建与测试任务编排
├─ AGENTS.md                       项目级 AI 开发规则
└─ README.md                       当前能力、安装、启动和安全边界
```

禁止修改或引用为源代码的生成目录：`node_modules/`、`dist/`、`out/`、`.nest-dev/`、`.generated/`、`.turbo/`、`.venv/`、`.data/`、`logs/`。

## 4. 共享契约：跨端改动的第一站

目录：[`packages/contracts/src/`](../../packages/contracts/src/)

所有跨 API、管理后台、桌面端、AI Runtime 或异步事件的字段变化，应先确认是否需要修改这里的 Zod schema 和 TypeScript 类型，再修改服务端和客户端。

主要契约文件：

| 文件                                                                       | 领域                                   |
| -------------------------------------------------------------------------- | -------------------------------------- |
| `admin.ts`、`admin-agent.ts`、`admin-overview.ts`                          | 管理端通用、智能体、总览               |
| `auth.ts`、`auth-session.ts`、`identity-governance.ts`                     | 登录、会话、MFA、企业身份治理          |
| `people-organization.ts`、`personal-manual.ts`                             | 组织人才、成员资料、个人使用说明书     |
| `role-blueprint.ts`、`role-assignment.ts`                                  | 角色蓝图与角色任命                     |
| `business-semantics.ts`、`employee-task-execution.ts`                      | 价值、战略、目标、任务、交付和员工执行 |
| `process-runtime.ts`、`business-events.ts`                                 | 流程运行和业务事件                     |
| `conversation.ts`、`im-realtime.ts`                                        | 会话、消息、反馈和实时通信             |
| `agent-run.ts`、`employee-agent-collaboration.ts`                          | Agent Run 和员工智能体协同             |
| `tool-gateway.ts`                                                          | 工具定义、调用、审批、回执、对账       |
| `knowledge-events.ts`、`knowledge-provider.ts`、`knowledge-source-sync.ts` | 知识事件、乐享等外接知识、知识来源同步 |
| `knowledge-graph-governance.ts`、`knowledge-retrieval-evaluation.ts`       | 图谱治理和检索评测                     |
| `memory-experience.ts`、`employee-experience-usage.ts`                     | 记忆、经验候选和员工使用               |
| `ai-evaluation.ts`、`ai-safety-model-routing.ts`                           | AI 评测、安全、模型路由                |
| `marketing-management.ts`、`finance-finops.ts`                             | 营销管理和 FinOps                      |

契约修改的最小验证：

```powershell
pnpm --filter @enterprise/contracts typecheck
pnpm --filter @enterprise/contracts test
pnpm --filter @enterprise/contracts build
```

不要在前端或后端复制一份“几乎一样”的接口类型；从 `@enterprise/contracts` 导入。破坏性的异步事件字段变化必须发布新版本，不能原地改变 `.v1` 的语义。

## 5. NestJS API

目录：[`apps/api/`](../../apps/api/)

### 5.1 固定结构

```text
apps/api/
├─ prisma/
│  ├─ schema.prisma                业务数据模型事实入口
│  ├─ migrations/                  只新增前向 migration
│  └─ seed.ts                      本地种子数据
├─ scripts/                        Prisma 包装和数据库测试入口
├─ src/
│  ├─ bootstrap/                   启动后的后台能力装配
│  ├─ common/                      context/filter/interceptor/middleware/pipe
│  ├─ config/                      环境配置及 fail-fast 校验
│  ├─ database/                    Prisma、多数据库角色和事务上下文
│  ├─ health/                      live/ready 探针
│  ├─ modules/                     业务模块
│  ├─ observability/               tracing、metrics、日志
│  └─ app.module.ts                顶层模块装配
└─ test/                           PostgreSQL、RLS、跨域集成和 E2E 测试
```

典型模块内部按复杂度使用以下层次：

```text
module/
├─ application/                    用例、Worker、编排
├─ domain/                         状态机、策略、Port、模型
├─ infrastructure/                Prisma、HTTP、供应商适配器
├─ testing/                        领域测试夹具
├─ *.controller.ts                HTTP 边界
├─ *.service.ts                   简单模块的应用服务
├─ *.module.ts                    Nest 依赖装配
└─ *.spec.ts                      单元/架构/迁移静态测试
```

### 5.2 API 模块职责路由表

| 模块目录                     | 主要职责                                                | 改动前优先阅读                                                            |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `auth`                       | 注册、登录、Token、恢复、邀请、MFA 相关基础能力         | `auth.module.ts`、controller、application、认证集成测试                   |
| `identity`                   | 当前请求主体和身份仓储边界                              | `identity.module.ts`、domain ports                                        |
| `identity-governance`        | OIDC/SAML/SCIM、设备、Break Glass、安全治理             | controller、service、`prisma-identity-governance.integration.spec.ts`     |
| `authorization`              | 统一授权决策和 obligations                              | `authorization-decision.service.ts` 及策略测试                            |
| `directory`                  | 组织目录读取和桌面 Bootstrap 投影                       | service、repository                                                       |
| `admin`                      | 管理端组织、成员、角色、智能体、知识的 HTTP 聚合入口    | 对应 `*-admin.controller/service/module.ts`；不要把跨域逻辑继续堆进聚合层 |
| `admin-overview`             | 管理端业务和运行状态总览                                | controller/service、管理端 overview feature                               |
| `agent-control`              | 智能体模板、版本、实例和目录自动配置                    | domain ports、Prisma repository、provisioner                              |
| `role-assignment`            | 当前员工角色任命读取                                    | controller/service                                                        |
| `agent-run`                  | Run 创建、队列、输入预算、流式事件、取消/重试/对账      | `domain/`、worker、Prisma repository、Runtime client                      |
| `ai-safety-model-routing`    | 模型目录、路由、连接探测、安全策略和熔断状态            | route policy、readiness client、FinOps 联动                               |
| `ai-evaluation`              | 数据集、Run、指标、坏例和发布检查                       | service、runner、契约与数据库测试                                         |
| `tool-gateway`               | 工具注册、Schema、风险、审批、执行、UNKNOWN 对账和补偿  | domain policy/state machine、worker、HTTP adapter                         |
| `business-semantics`         | Value→Strategy→Objective→Task→Deliverable→Evidence 主链 | 对应 controller/service、policy、persistence                              |
| `process-orchestration`      | 流程/协同/纠偏领域状态机和共享适配器                    | `domain/` 状态机、安全/迁移测试；该目录是被其他模块复用的内部库           |
| `process-runtime`            | 流程实例、步骤、SLA、人工接管和任务联动                 | service、repository、authorization port                                   |
| `business-events`            | 版本化业务事件和事件写入                                | event service、契约                                                       |
| `collaboration-correction`   | 项目任务中的反馈、纠偏和协作操作                        | controller/service、状态机依赖                                            |
| `conversation`               | 会话、参与者、消息、回答反馈和流式游标                  | service、repository、反馈评测投影                                         |
| `im-outbox`                  | 消息可靠投递、Local/Tencent/WuKong Provider、实时会话   | worker、provider、Outbox 集成测试                                         |
| `knowledge-gateway`          | 知识边界唯一同进程公共入口                              | port、in-process gateway、架构红线测试                                    |
| `knowledge-ingestion`        | 文件安全检查、对象存储、解析、切片、版本和异步 Worker   | worker、parser adapters、object-store modules                             |
| `knowledge-retrieval`        | ACL 前置检索、词法/向量/RRF/Rerank、引用和外部结果合并  | service、citation、retrieval tests                                        |
| `knowledge-search-index`     | Qdrant 等搜索索引适配器                                 | `KnowledgeSearchIndex` port 与 adapter                                    |
| `knowledge-semantic`         | API 到 AI Runtime 的 Embedding/Rerank 客户端            | `knowledge-ai-runtime.client.ts`                                          |
| `knowledge-provider`         | 腾讯乐享连接、身份、空间、目录和远程检索适配            | application services、`infrastructure/lexiang/`                           |
| `knowledge-graph-governance` | 本体、谓词、实体合并、冲突和校正治理                    | controller/service、知识网关约束                                          |
| `memory-experience`          | 五层记忆、经验候选、审核、发布和知识投影                | domain state machine、repository、projection port                         |
| `employee-insights`          | 员工侧经验来源和 AI 使用情况                            | workbench controllers/services                                            |
| `people-organization`        | 能力、发展计划、铁三角、组织变更、个人资料              | admin/workbench controller、service                                       |
| `marketing-management`       | 营销观察、洞察、主数据、目标和行动计划                  | evidence/master-data/planning services                                    |
| `finance-finops`             | 价格、成本、分摊、收益、ROI、预算、预警、路由建议       | service、投影 Worker、数据库集成测试                                      |
| `audit-governance`           | 审计查询、导出和哈希链核验                              | controller/service、数据库审计测试                                        |

顶层 [`app.module.ts`](../../apps/api/src/app.module.ts) 只装配公开业务模块；`knowledge-ingestion`、`knowledge-retrieval`、`knowledge-search-index`、`knowledge-semantic`、`process-orchestration` 等可以由上层模块传递导入，不要因为未直接出现在顶层 imports 就误判为死代码。

### 5.3 API 路由分区

- `/auth`、`/identity`：登录和当前身份。
- `/admin/*`：管理后台治理入口。
- `/workbench/*`：员工任务、工具、记忆、人才和经验入口。
- `/conversations`、`/messages`、`/im`：会话、反馈和实时通信。
- `/knowledge-citations`：权限内引用读取。
- `/scim/v2/*`：企业身份同步边界。
- `/health/live`、`/health/ready`：存活和就绪探针。

实际路径以 controller 的 `@Controller()` 和方法装饰器为准，不要从前端 URL 猜 API。

### 5.4 数据库与 migration

事实入口：[`apps/api/prisma/schema.prisma`](../../apps/api/prisma/schema.prisma)

当前 schema 覆盖租户认证、组织任职、知识、智能体、会话消息、业务语义、流程、工具、记忆经验、评测、营销、人才、FinOps、模型治理和图谱治理。修改数据结构时：

1. 先确认模型属于哪个业务边界。
2. 修改 `schema.prisma`。
3. 新增按时间排序的前向 migration，禁止修改已经存在的历史 migration。
4. 同步补租户复合外键、索引、RLS policy、能力角色 GRANT 和必要的数据回填。
5. 运行 `db:validate`、`db:generate`、静态 migration spec。
6. 在全新隔离数据库运行全部 migration 和 `pnpm test:db`。

跨知识边界不得直接读写 `Knowledge*` Prisma 模型或 `knowledge_*` SQL；先扩展传输中立的 Gateway DTO。边界规则见 [`ADR-0008`](../adr/0008-knowledge-independent-business-boundary.md)，CI 红线见 [`knowledge-boundary.architecture.spec.ts`](../../apps/api/src/modules/knowledge-gateway/knowledge-boundary.architecture.spec.ts)。

## 6. 管理后台

目录：[`apps/admin/`](../../apps/admin/)

```text
apps/admin/src/
├─ api/                             后台公共 API 客户端与错误处理
├─ app/                             Shell、导航、路由和按页拆包
├─ auth/                            Web 会话和认证上下文
├─ components/knowledge/            知识库复用组件
├─ features/                        按产品能力拆分的页面
├─ styles/design-tokens.css         UI Token 权威来源
├─ styles.css                       全局样式装配
└─ test/                            DOM 测试支持
```

### 6.1 当前一级产品信息架构

导航事实入口：[`admin-navigation.ts`](../../apps/admin/src/app/admin-navigation.ts)

| 一级入口   | 二级功能与代码目录                                                   |
| ---------- | -------------------------------------------------------------------- |
| 业务概览   | `features/admin-overview`                                            |
| 组织与成员 | `organization`、`members`、`role-assignments`、`people-organization` |
| 智能体中心 | `agents`、`role-blueprints`、`ai-evaluation`、`ai-model-routing`     |
| 知识中心   | `knowledge`、`knowledge-integrations`、`experience-governance`       |
| 业务管理   | `business-semantics`；营销等页面可能保留代码但未进入当前主导航       |

`finance-finops`、`runtime-governance`、`tool-governance`、`audit-governance`、`identity-governance` 等代码仍存在，但部分旧路由当前会重定向到主页面。不要仅因 feature 目录存在就给用户增加一级菜单；先核对产品信息架构和 `AdminShell.tsx` 的实际路由装配。

### 6.2 前端改动规则

- 跨端字段先改 `packages/contracts`，再改 API client 和页面。
- 页面必须覆盖 loading、empty、error、permission denied、degraded、success 状态。
- 视觉值使用 [`design-tokens.css`](../../apps/admin/src/styles/design-tokens.css)，并同步维护 [`admin-ui-style-spec.md`](../design-system/admin-ui-style-spec.md)。
- 不新增内联颜色、字号、圆角、阴影和常规间距。
- 普通用户表单不要求填写 tenant、内部 ID、状态机、模型、追踪号或 JSON。
- 按钮应直接表达业务动作；不要把主要操作藏进“高级”折叠区。
- DOM 测试通过不代表视觉正确；UI 修改后必须打开真实页面检查桌面宽度、窄屏、长中文、长 URL、错误消息、滚动归属和弹窗。

前端最小验证：

```powershell
pnpm --filter @enterprise/admin typecheck
pnpm --filter @enterprise/admin test
pnpm --filter @enterprise/admin build
```

## 7. Electron 员工端

目录：[`apps/desktop/`](../../apps/desktop/)

```text
apps/desktop/src/
├─ main/                            Electron 主进程、令牌、账号保险箱、SSE、IM
├─ preload/                         唯一受控 IPC 桥
├─ shared/desktop-api.ts            Main/Preload/Renderer 共享 IPC 契约
└─ renderer/src/
   ├─ app/                          登录、Bootstrap、主工作区装配
   └─ features/
      ├─ auth/                      登录、改密、多账号切换
      ├─ directory/                 主工作区、组织和联系人导航
      ├─ messaging/                 会话、消息、智能体协同
      ├─ workbench/                 目标、任务、交付和执行
      ├─ roles/                     我的角色
      ├─ tools/                     工具调用、确认和审批
      ├─ memory/                    我的记忆
      ├─ experience-usage/          经验和 AI 使用
      ├─ people/                    员工自助人才信息
      └─ personal-manual/           个人使用说明书和工作可用性
```

安全边界：

- access token 只在 Main 内存；refresh token 用系统 `safeStorage` 加密。
- Renderer 禁止直接访问 Node、文件系统、Shell 和密钥。
- 所有系统能力必须经窄化的 Preload IPC，并同步更新 `shared/desktop-api.ts` 和测试。
- 客户端只展示服务端持久化的业务事实，不伪造 Agent 成功、消息送达或审批完成。

前端或 IPC 改动后的最小验证：

```powershell
pnpm --filter @enterprise/desktop typecheck
pnpm --filter @enterprise/desktop test
pnpm --filter @enterprise/desktop build
```

涉及 Main/Preload 时要同时运行 Node 与 Web 两套 typecheck；涉及真实 Electron 行为时还需启动客户端做人工 UAT。

## 8. Python AI Runtime

目录：[`services/ai-runtime/`](../../services/ai-runtime/)

```text
services/ai-runtime/
├─ src/enterprise_ai_runtime/
│  ├─ domain/                       执行状态、输入输出和错误模型
│  ├─ ports/                        Runtime、RunStore 等抽象
│  ├─ adapters/                     OpenAI-compatible、Manus、Postgres、FastEmbed
│  ├─ services/                     Run、Knowledge、Evaluation 用例
│  ├─ api.py                        Run/health 内部接口
│  ├─ knowledge_api.py              capabilities/embeddings/rerank
│  ├─ config.py                     环境配置和生产约束
│  └─ main.py                       FastAPI 装配、认证、Telemetry
└─ tests/                           pytest 单元与适配器测试
```

运行边界：

- API 控制权限和业务状态，Runtime 不直接承担企业授权。
- `/internal/*` 在配置服务令牌后必须使用 Bearer 服务身份。
- 生产禁止 `InMemoryRunStore` 和 `NoopRuntime`。
- 生成模型、Embedding、Rerank 是三套独立驱动和 readiness，不要用“模型可用”替代三项检查。
- OpenAI-compatible 与 Manus 等适配器不得把供应商响应直接泄漏给业务层。

验证命令：

```powershell
pnpm test:ai
pnpm lint:ai
# 或
.\.venv\Scripts\python.exe -m pytest services\ai-runtime
.\.venv\Scripts\python.exe -m ruff check services\ai-runtime
```

## 9. 基础设施、验收工具和文档

### 9.1 `infra/`

- `docker-compose.dev.yml`：通用 PostgreSQL/Redis 本地底座。
- `docker-compose.knowledge.dev.yml`：MinIO、Qdrant、Docling、Tika、ClamAV 等知识基础设施。
- `docker-compose.pgvector.dev.yml`：pgvector 开发数据库。
- `docker-compose.wukongim.dev.yml`：WuKongIM。
- `observability/`：Prometheus 和 OTLP 示例配置。
- `operations/`、`scripts/`：监控、告警、备份、恢复、灾备和 Windows 计划任务脚本。

### 9.2 `tools/`

- `semantic_acceptance/`：企业问题集、离线/联网 Provider、检索指标和质量门禁。
- `knowledge-smoke/run-e2e.mjs`：知识摄取/检索冒烟。
- `knowledge-smoke/run-agent-e2e.mjs`：知识到 Agent 回答的端到端验证。
- `knowledge-source-fixture.mjs`：知识来源测试夹具。
- `start-local-dev.ps1`：完整本地环境编排。

### 9.3 `docs/`

- [`企业AI协同平台-总体技术方案.md`](../企业AI协同平台-总体技术方案.md)：产品、容器架构、安全、部署和阶段路线总基线。
- [`BMS-AI_V2_实施计划.md`](../BMS-AI_V2_实施计划.md)：需求批次、当前状态和 Definition of Done。
- [`BMS-AI_V2_验收矩阵.md`](../BMS-AI_V2_验收矩阵.md)：每项能力所需的不可替代证据。
- [`adr/`](../adr/)：必须遵守的架构决策，尤其是数据库安全和知识边界。
- [`runbooks/`](../runbooks/)：本地数据库、知识生产接线、语义检索、外部能力、身份、备份恢复和可观测性验收。
- [`design-system/`](../design-system/)：UI Token 和组件规范。
- [`codex/`](./)：专题分析、问题修复和阶段性验收记录。

## 10. 核心业务链路与修改入口

### 10.1 登录与桌面 Bootstrap

```text
Desktop Renderer
  → Preload IPC
  → Main desktop-auth-manager / account-store
  → API auth + directory
  → PostgreSQL tenant/user/session/org
  → Bootstrap 契约返回员工工作区
```

常改位置：

- 契约：`auth*.ts`、`bootstrap.ts`、`people-organization.ts`
- API：`auth`、`identity`、`directory`、`admin/organization-*`
- Desktop：`main/desktop-auth-manager.ts`、`features/auth`、`features/directory`
- 测试：认证集成、RLS、Desktop Main、Auth DOM、Bootstrap contract

### 10.2 企业战略到交付验收

```text
Value → Strategy → Objective → Metric
                      ↓
                    Task → Process Instance/Step
                      ↓
                 Deliverable → Evidence → Acceptance
```

常改位置：

- 契约：`business-semantics.ts`、`employee-task-execution.ts`、`process-runtime.ts`
- API：`business-semantics`、`process-orchestration`、`process-runtime`、`business-events`
- Admin：`features/business-semantics`
- Desktop：`features/workbench`
- 数据库：Strategy、Objective、Task、Process、Deliverable、Evidence、Acceptance 模型及 migration

### 10.3 会话到 Agent 回复

```text
员工发送消息
  → Conversation 持久化 + Outbox/Audit
  → AgentRun 排队与配额预留
  → ACL 内知识/记忆上下文组装
  → HTTP Agent Runtime
  → 供应商执行/流式事件
  → 可信用量与终态持久化
  → 消息回写 + IM/SSE 展示
```

常改位置：

- `conversation`、`agent-run`、`im-outbox`、`ai-safety-model-routing`
- AI Runtime `api.py`、services、runtime adapters
- Desktop `features/messaging`
- 契约 `conversation.ts`、`agent-run.ts`、`im-realtime.ts`

任何改动都要覆盖：取消、重试、UNKNOWN、重复投递、断线续传、配额、可信 Token 回执和越权负向场景。

### 10.4 本地知识摄取与检索

```text
上传/导入
  → 文件安全检查
  → 对象存储
  → KnowledgeIngestionJob
  → Worker 解析/复核/切片
  → 词法 + pgvector/Qdrant 索引
  → ACL 前置召回 + RRF + 可选 Rerank
  → 引用与版本证据
```

常改位置：

- 管理入口：`admin/knowledge-admin.*`
- 公共边界：`knowledge-gateway`
- 内部实现：`knowledge-ingestion`、`knowledge-retrieval`、`knowledge-search-index`、`knowledge-semantic`
- UI：`features/knowledge`、`components/knowledge`
- AI Runtime：`knowledge_api.py` 和 KnowledgeService
- 验收：知识集成测试、架构红线、`tools/knowledge-smoke`、`semantic_acceptance`

### 10.5 腾讯乐享外接知识库

```text
管理端知识来源
  → KnowledgeProviderConnection（加密 AppSecret）
  → 团队/操作成员身份验证
  → 本地 KnowledgeBase ↔ 乐享 Space 绑定
  → 目录/文档元数据投影
  → 本地 ACL 过滤
  → 乐享 AI Search API 远程检索正文证据
```

常改位置：

- 契约：`knowledge-provider.ts`、`admin.ts`
- API：`knowledge-provider`、`admin/knowledge-admin.*`、`knowledge-retrieval`
- Admin：`features/knowledge-integrations`、`features/knowledge`、`components/knowledge`
- Prisma：ProviderConnection、UserBinding、ExternalSpaceBinding、ExternalEntryBinding
- 专题记录：[`2026-08-12-乐享外接知识库专用模块方案.md`](./2026-08-12-乐享外接知识库专用模块方案.md)

乐享目录投影不是本地正文副本。不要因为页面显示了文档数量，就假定本地 chunk/embedding 已存在；远程库应通过乐享检索 API 获取正文证据，同时先执行本系统 ACL。

### 10.6 Tool Gateway

```text
Agent/员工提出动作
  → Tool Definition + JSON Schema
  → 身份/租户/风险/出站策略
  → dry-run 或确认/审批
  → 幂等执行
  → Receipt
  → UNKNOWN 对账/补偿
```

常改位置：`tool-gateway/domain`、application workers、HTTP dispatcher、Prisma repositories、Admin/Workbench 工具 UI。高风险或不可逆动作不能通过减少步骤来“优化体验”。

### 10.7 记忆与经验沉淀

```text
任务/交付/证据
  → 经验候选
  → 脱敏、审核、验证
  → 发布到角色/组织范围
  → KnowledgeGateway 投影
  → 后续任务权限内复用
```

常改位置：`memory-experience`、`employee-insights`、Admin `experience-governance`、Desktop `memory`/`experience-usage`。必须保留来源证据、状态机、撤销和未审核隔离。

## 11. “我要改什么”快速路由

| 任务类型         | 首先修改/阅读                             | 必须联动检查                                                    |
| ---------------- | ----------------------------------------- | --------------------------------------------------------------- |
| 新增跨端字段     | `packages/contracts`                      | API 映射、Admin/Desktop client、契约测试                        |
| 新增业务实体     | `schema.prisma` + 新 migration            | RLS、复合外键、GRANT、repository、集成测试                      |
| 新增管理页面     | `admin/src/features/<domain>`             | 导航、Shell 懒加载、API client、DOM/浏览器检查、设计 Token      |
| 新增员工端功能   | `desktop/.../features/<domain>`           | Bootstrap/API 契约、Main/Preload 安全、Electron UAT             |
| 新增 API         | 对应业务 module controller/service        | Zod 契约、授权、审计、幂等、失败响应                            |
| 新增 Worker      | `application/*.worker.ts`                 | 队列 repository、租约、退避、幂等、UNKNOWN/死信、Bootstrap 装配 |
| 新增模型供应商   | AI Runtime `adapters`                     | config fail-fast、readiness、超时、错误映射、真实联网验收       |
| 新增外部工具     | `tool-gateway` adapter                    | 出站 URL/DNS、Schema、审批、回执、对账和补偿                    |
| 新增知识来源     | `knowledge-provider` 或知识来源 sync port | Knowledge Gateway、ACL、版本化事件、ADR-0008                    |
| 修改检索         | `knowledge-retrieval`                     | ACL 前置、版本、引用、评测集、越权负向、延迟/容量               |
| 修改智能体回复   | `conversation` + `agent-run` + Runtime    | 输入预算、知识/记忆、流式、取消、可信用量、重复消息             |
| 修改权限         | `authorization` + 数据库 RLS              | UI 隐藏不能替代 API/DB 拒绝；补跨租户负向测试                   |
| 修改 UI 样式     | design tokens + 对应 feature/component    | 样式规范、窄屏/长文本/滚动和真实浏览器                          |
| 修改产品状态描述 | 页面 + 实施计划/验收矩阵                  | 确认真实证据，不能把 mock/排队/HTTP 200 写成可用                |

## 12. 测试地图

### 12.1 测试层次

| 层次              | 位置                                         | 主要证明                                        |
| ----------------- | -------------------------------------------- | ----------------------------------------------- |
| 契约测试          | `packages/contracts/src/*.spec.ts`、`test/`  | 字段、枚举、默认值和兼容性                      |
| API 单元/架构测试 | `apps/api/src/**/*.spec.ts`                  | 状态机、策略、适配器、边界和静态 migration 约束 |
| API 数据库集成    | `apps/api/test/prisma-*.integration.spec.ts` | PostgreSQL、RLS、ACL、事务、并发、幂等、Outbox  |
| API E2E           | `apps/api/test/app.e2e-spec.ts`              | Nest HTTP 边界和异常格式                        |
| Admin DOM         | `apps/admin/src/**/*.test.ts(x)`             | 页面状态、交互、请求载荷和可访问语义            |
| Desktop 单元/DOM  | `apps/desktop/src/**/*.test.ts(x)`           | Main/IPC、安全账号、工作区交互                  |
| AI Runtime        | `services/ai-runtime/tests/`                 | 配置、状态机、API、Provider、Store、Telemetry   |
| 语义验收          | `tools/semantic_acceptance/tests/`           | 数据集、指标、离线/真实 Provider 行为           |
| 知识/Agent 冒烟   | `tools/knowledge-smoke/`                     | 从摄取、检索、引用到 Agent 回答的闭环           |
| 基础设施脚本测试  | `infra/scripts/tests/`                       | 告警、备份、恢复、连续性和安全脚本              |
| 人工 UAT          | 浏览器、Electron、真实外部系统               | 布局、真实会话、外部权限、业务正确性和可恢复性  |

截至本导航创建时，按文件名粗略扫描可见：Contracts 约 39 个测试相关文件、API 约 265 个、Admin 约 79 个、Desktop 约 54 个、AI Runtime 15 个、语义验收 16 个、知识 smoke 4 个。数字只用于理解覆盖规模，不作为门禁结论；每次候选版本都必须重新运行命令。

### 12.2 按风险递增的验证顺序

先运行目标模块最小测试，再逐步扩大，避免一开始用全仓噪声掩盖根因：

```powershell
# 1. 目标测试（示例）
pnpm --filter @enterprise/api exec vitest run src/modules/knowledge-retrieval/knowledge-retrieval.service.spec.ts

# 2. 包级检查
pnpm --filter @enterprise/contracts test
pnpm --filter @enterprise/api typecheck
pnpm --filter @enterprise/api test
pnpm --filter @enterprise/admin test
pnpm --filter @enterprise/desktop test
pnpm test:ai

# 3. 数据库与架构
pnpm db:validate
pnpm db:generate
pnpm test:db

# 4. 全仓质量
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
```

测试失败时要区分：

- 本次改动导致的回归；
- 当前工作树中其他未提交任务造成的失败；
- 缺少 Docker、数据库、模型或外部凭据造成的环境阻断；
- 测试本身只证明 mock/静态结构，尚未证明真实业务。

不要为了通过测试而削弱 RLS、架构红线、错误断言或验收阈值。

### 12.3 UI 和外部能力的额外验证

- Admin：启动 `pnpm dev:admin` 和 API，用浏览器完成真实登录与目标页面操作。
- Desktop：启动 `pnpm dev:desktop`，检查 Main/Preload/Renderer 的真实联动。
- 知识：使用非空真实文件、权限不同的成员和企业问题集；空集合不能证明 RAG。
- 模型：分别验证生成、Embedding、Rerank readiness、失败降级和账单回执。
- IM：验证真实 Provider、重复投递、断网恢复、回调和用户身份。
- 身份：验证真实 IdP 签名、元数据、SCIM 兼容性、邀请/恢复邮件。
- 运维：验证隔离恢复、RLS/ACL 恢复后门禁、异地存储、告警和 OTLP/SIEM。

## 13. 本地开发和启动

环境要求：Node.js 24、pnpm 11、Python 3.12、Docker Desktop。

```powershell
Copy-Item .env.example .env
pnpm install
pnpm setup:electron
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".\services\ai-runtime[dev]"

pnpm dev:all          # 基础设施 + API + Runtime + Admin + Desktop
pnpm dev:all:infra    # 只启动并检查基础设施
pnpm dev              # 基础设施已经运行时启动应用
```

默认开发地址：

- API：`http://127.0.0.1:3000`
- Admin：`http://127.0.0.1:4173`
- AI Runtime：`http://127.0.0.1:8100`
- API live/ready：`/health/live`、`/health/ready`
- Runtime 文档：`http://127.0.0.1:8100/internal/docs`

详细步骤和故障处理以 [`本地开发与数据库验证.md`](../runbooks/本地开发与数据库验证.md) 为准。

## 14. 产品优化导航

### 14.1 产品主链

任何产品优化优先服务这条主链：

```text
企业价值
  → 战略方向
  → 经营/部门目标
  → 项目与任务
  → 员工/智能体执行
  → 交付物与业务证据
  → 验收
  → 经验沉淀与复用
```

页面和功能数量不是价值指标。优先看：战略落地率、员工完成任务所需时间、风险发现速度、交付验收质量、知识命中与引用质量、经验复用效果、越权率和人工接管质量。

### 14.2 优化问题的判断顺序

1. 用户当前目标是什么？
2. 下一步动作是否清晰且可执行？
3. 系统展示的是实际状态还是乐观假象？
4. 阻塞、风险、依赖、截止时间和审批是否可见？
5. AI 输出是否有来源、版本、权限和证据？
6. 用户能否确认、修改、拒绝或转人工？
7. 失败后能否安全重试、恢复、对账或回滚？
8. 是否真正减少员工工作量，而非增加配置负担？

### 14.3 优先级建议

按以下顺序优化，而不是先增加新页面：

1. **安全和数据正确性**：越权、数据丢失、错误审批、跨租户风险。
2. **核心业务闭环阻断**：任务不能执行、结果不能验收、证据不能追溯。
3. **真实能力与页面状态不一致**：虚假在线、空检索、排队成功冒充执行成功。
4. **失败恢复和可观测性**：UNKNOWN、重试、对账、请求 ID、告警。
5. **高频效率问题**：重复录入、无意义 ID、上下文丢失、过多点击。
6. **体验和视觉一致性**：信息层级、响应式、长内容、安全提示。
7. **新能力和高级治理**：只有前述闭环稳定后再扩展。

### 14.4 变更产品文案时的状态词

推荐使用可验证表述：

- “已保存”“已排队”“处理中”“等待审批”“执行成功”“执行失败”“结果未知”。
- “仅词法检索”“远程乐享检索”“Embedding 未就绪”“Rerank 已降级”。
- “仓库测试通过”“等待真实供应商验收”“等待业务 Owner 签字”。

避免：

- 把 HTTP 200 写成“操作已完成”。
- 把 Worker 入队写成“已同步”。
- 把 mock Provider 写成“模型在线”。
- 把文件目录投影写成“正文已经进入本地 RAG”。
- 把代码存在写成“生产可用”。

## 15. 后续 AI 的标准工作流

### 15.1 开始前

- [ ] 读 `AGENTS.md`、目标模块代码、契约、测试和相关 ADR。
- [ ] 查看 dirty worktree，记录哪些变更不是本任务的。
- [ ] 从 UI/调用方一直追到数据库或外部 Provider，定位真正责任边界。
- [ ] 明确权限、失败分支、幂等、审计和验收证据。
- [ ] 判断是否需要契约、migration、事件新版本或文档更新。

### 15.2 实现时

- [ ] 复用已有 Gateway、Port、适配器和状态机，不建立平行旁路。
- [ ] 跨端字段先改契约。
- [ ] 数据变更只新增 migration。
- [ ] 权限同时落在 API 和数据库；前端隐藏按钮不算授权。
- [ ] 外部调用具备超时、错误映射、幂等/对账和凭据保护。
- [ ] UI 覆盖 loading/empty/error/degraded/permission/success。
- [ ] 不记录密钥、Cookie、Token、原始敏感内容或模型思维链。

### 15.3 交付前

- [ ] 目标测试、typecheck、相关 package test/build 已运行。
- [ ] 有数据变更时已完成 validate/generate/隔离数据库测试。
- [ ] UI 已在真实客户端检查，不只看 DOM test。
- [ ] 外部系统未验证的部分明确写出，不冒充完成。
- [ ] 更新既有 Markdown；没有合适文档时在 `docs/codex/YYYY-MM-DD-主题.md` 新建记录。
- [ ] 最终说明实际能力、修改文件、实际命令、失败/阻断和未验证项。

## 16. 本目录专题文档索引

本目录的日期文档按问题域大致分为：

- **知识库与 RAG**：知识向量、权限范围、空间树、Gateway/Qdrant、文件夹上传、批量摄取、解析、乐享外接。
- **智能体与模型**：模型可用性、回复链路、首字延迟、员工智能体协同与数字工作分身。
- **客户端与产品体验**：管理端精简、表单去技术化、Lighthouse、知识库非技术用户体验。
- **组织与通讯**：飞书登录/成员、共享会话、IM/OCTO 接入。
- **故障诊断**：API 启动、语义服务、入库异常和 Worker 异常。

文件名中的日期表示当时的工作记录。引用结论前要重新核对当前代码和测试；新记录应优先更新已有同主题文档，避免同一问题产生多份互相冲突的总结。

## 17. 维护本导航

以下变化发生时更新本文件：

- 新增或删除顶层 workspace、API 业务边界、管理端一级入口或桌面端核心 feature。
- 修改知识、Tool Gateway、AI Runtime、数据库安全等关键依赖方向。
- 新增全仓门禁、真实验收工具或主要 runbook。
- 产品主链、阶段范围或 Definition of Done 发生变化。

不要在本导航写死易变的接口字段、migration 总数或测试通过数字。字段以契约为准，表结构以 schema/migration 为准，状态以验收矩阵和本次实际运行证据为准。
