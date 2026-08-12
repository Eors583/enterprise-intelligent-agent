# BMS-AI 项目级 Codex 说明

本文件适用于整个 `enterprise-intelligent-agent` 仓库。后续开发先遵循这里的产品目标和工程边界，再阅读相邻代码、测试和文档。

## 1. 项目目标

### 1.1 一句话定位

**通过 AI 赋能企业协作：让每名员工拥有与岗位对齐的智能体，让企业战略能够被规整、拆解、执行、跟进和复盘。**

### 1.2 四项核心能力

1. **员工智能体**
   - 理解员工的岗位、职责、权限、目标和工作上下文。
   - 在权限范围内检索企业知识，协助计划、分析、沟通和交付。
   - 主动提醒待办、风险、依赖、截止时间和需要确认的事项。
   - 可以参与受控协作，但不能越权替员工做高风险决定。

2. **企业战略规整**
   - 把分散在文档、会议和管理者表达中的战略转为统一结构。
   - 主链为：`企业价值 → 战略方向 → 经营目标 → 部门目标 → 项目 → 任务 → 交付物 → 指标与证据`。
   - 识别目标冲突、重复建设、责任缺失和执行断层。

3. **智能体对齐与项目跟进**
   - 将智能体绑定到岗位、战略、项目、任务和明确权限。
   - 根据项目目标生成计划、里程碑和下一步行动。
   - 持续跟进进度、阻塞、风险、依赖、截止时间和审批。
   - 汇总人和智能体的工作结果，形成可验证的项目状态。

4. **企业知识与组织经验**
   - 企业制度、项目资料和历史经验统一进入权限受控的知识库。
   - 项目验收后将有效方法沉淀为企业记忆，供后续员工和智能体复用。

产品价值不以智能体数量、页面数量或 Token 用量衡量，而以战略落地率、员工任务效率、项目风险发现速度、交付验收质量和经验复用效果衡量。

## 2. 初版业务流程

1. 管理员建立企业、组织、岗位、成员、角色和权限。
2. 企业录入或导入战略、目标、制度和知识资料。
3. 系统将战略规整并拆解到部门、项目、岗位和负责人。
4. 每名员工获得与岗位、权限和知识范围对齐的员工智能体。
5. 员工或负责人创建项目和任务，明确目标、负责人、成功标准、截止时间和验收人。
6. 智能体结合企业知识生成计划，并协助员工执行。
7. 智能体持续检查里程碑、延期、阻塞和依赖，推动需要的协作、确认或审批。
8. 人与人、人与智能体、智能体与智能体在同一项目上下文中协作。
9. 项目形成交付物、引用、工具回执和业务证据，由负责人验收。
10. 验收后的有效经验进入企业记忆，并在后续项目中复用。

初版必须能让一个真实项目从战略/目标建立开始，经过任务执行、智能体协助、持续跟进、结果提交和业务验收完整走通。

## 3. 初版规划

| 阶段        | 目标                               | 主要范围                                                                               |
| ----------- | ---------------------------------- | -------------------------------------------------------------------------------------- |
| P0 基础闭环 | 战略能落到项目，项目能被执行和验收 | 组织成员、员工智能体、战略目标、项目任务、知识检索、协作消息、交付证据、统一待办、验收 |
| P1 主动协作 | 智能体能持续跟进项目并安全执行     | 里程碑检查、风险提醒、项目摘要、受控多智能体、Tool Gateway、审批、实时消息、断点恢复   |
| P2 组织学习 | 企业能复用经验并评估 AI 价值       | 记忆候选、经验审核、知识发布、项目复盘、指标关联、评测、成本和外部系统集成             |

初版明确不做：

- 不训练自有基础大模型；模型通过可替换 API 或批准的本地模型接入。
- 不依赖某一家厂商的智能体或知识库作为系统核心。
- 不允许智能体无限递归、无边界广播或越权执行。
- 不保存或展示模型原始思维链，只保存计划、动作、结果和证据摘要。
- 不把通用鼠标键盘自动化作为主路径，优先使用受治理的 API 工具。
- 不使用假数据、空响应、默认 `noop` 或静态页面冒充业务闭环已完成。

## 4. 产品结构

### 4.1 员工端

- 工作台：我的目标、项目、任务、待办和最近结果。
- 消息：员工、群组、智能体、项目通知和审批消息。
- 通讯录：组织、员工和智能体。
- 我的：个人资料、岗位、员工智能体和个人设置。

协同、纠偏、工具、记忆和经验属于项目执行能力，不分别增加一级菜单。

项目详情默认只突出：项目目标与下一步、执行进展与风险、交付物与验收。

### 4.2 管理端

- 业务概览。
- 组织与成员。
- 员工智能体与角色智能体。
- 企业战略、目标和项目管理。
- 企业知识库。
- 高级设置：模型、工具、身份安全、审计、成本和运维。

高级治理可以折叠，但不能因为精简界面而删除后端权限、审计、数据结构或 API。

### 4.3 表单原则

普通用户只填写业务目标、成功标准、负责人、必要时间要求和输入资料。ID、tenant、创建人、状态、时间戳、版本、模型、工具、风险、审批策略、追踪号和内部 JSON 由系统生成或推导。

## 5. 技术架构与目录

```text
Electron 员工端 / React 管理后台
                │
        TypeScript + Zod 契约
                │
        NestJS 企业业务 API
        ├─ 组织、战略、项目和任务
        ├─ 身份、权限、知识和记忆
        ├─ Agent Run、Tool Gateway
        └─ 消息、Outbox 和 Worker
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
PostgreSQL   Python AI   IM/模型/工具/存储
+ pgvector  Runtime     外部适配器
```

架构边界：

- NestJS API 是企业权限、项目状态、审批和业务数据的权威来源。
- PostgreSQL 是业务事实账本，租户数据通过复合键和 `FORCE RLS` 隔离。
- AI Runtime 负责模型运行，不能绕过 API 权限或 Tool Gateway。
- Tool Gateway 是智能体调用外部工具的唯一执行入口。
- Outbox/Worker 负责可靠处理消息、模型运行、工具执行和其他异步任务。
- 模型、IM、存储和业务系统通过适配器接入，不在业务代码中绑定单一供应商。
- 知识库是独立业务边界：智能体、项目、评测、管理端和第三方系统只能通过 `KnowledgeGateway`/`KnowledgeRetrievalGateway`、知识公共 API 或 `packages/contracts` 中的版本化知识事件使用知识能力。
- 非知识边界代码严禁直接访问知识 Prisma 模型、`knowledge_*` 原始 SQL、Qdrant collection、知识对象存储键/目录或知识内部实现类；公共 Gateway 契约不得暴露 Prisma transaction、数据库记录、collection 名或对象存储 key。
- 当前知识边界拥有 `knowledge-gateway`、`knowledge-ingestion`、`knowledge-retrieval`、`knowledge-search-index`、`knowledge-semantic`、`knowledge-graph-governance` 及明确登记的知识管理入口。新增边界例外必须先更新 ADR，不能只扩大架构测试白名单。
- 跨知识边界不共享数据库事务；调用方使用稳定 ID、版本、哈希、幂等键和正式事件处理并发与最终一致性。`knowledge-boundary.architecture.spec.ts` 是 CI 红线，不能跳过或弱化断言来通过构建。

```text
apps/
├─ api/                 NestJS API、Prisma、Migration、Worker 和集成测试
├─ admin/               React + Vite 企业管理后台
└─ desktop/             Electron + React 员工桌面端

packages/
├─ contracts/           Zod + TypeScript 跨端共享契约
└─ tsconfig/            TypeScript 公共配置

services/
└─ ai-runtime/          Python FastAPI 模型运行服务

infra/                  PostgreSQL、Redis、pgvector、WuKongIM、监控和运维脚本
tools/                  语义检索等独立验收工具
docs/                   产品方案、ADR、运行手册和 Codex 正式记录
```

关键目录：

- `apps/api/prisma/`：数据模型、前向 migration 和 seed。
- `apps/api/src/modules/`：企业业务模块。
- `apps/admin/src/features/`：管理端业务页面。
- `apps/desktop/src/main/`：Electron 主进程、令牌和系统能力。
- `apps/desktop/src/preload/`：受控 IPC。
- `apps/desktop/src/renderer/src/features/`：员工端功能页面。
- `packages/contracts/src/`：跨端请求、响应、状态和事件契约。
- `services/ai-runtime/src/enterprise_ai_runtime/`：domain、ports、adapters、services。
- `docs/codex/`：Codex 形成的产品、技术和验收记录。

不要修改 `node_modules/`、`dist/`、`out/`、`.nest-dev/`、`.generated/`、`.turbo/`、`.venv/`、`.data/`、`logs/` 等生成内容。

## 6. 技术栈

| 层         | 技术                                                    |
| ---------- | ------------------------------------------------------- |
| Monorepo   | Node.js 24、pnpm 11、Turborepo                          |
| 共享契约   | TypeScript 5.9、Zod 4                                   |
| API        | NestJS 11、Prisma 6、PostgreSQL 17                      |
| 管理后台   | React 19、Vite 7、Vitest                                |
| 桌面端     | Electron 43、React 19、TanStack Query                   |
| AI Runtime | Python 3.12、FastAPI、HTTPX、asyncpg、pytest、Ruff      |
| 知识检索   | 关键词、pgvector、RRF、Embedding、Rerank                |
| 异步与消息 | PostgreSQL Outbox、Worker、Redis、WuKongIM              |
| 模型接入   | OpenAI-compatible、受控外部模型适配、本地 FastEmbed/BGE |
| 可观测性   | OpenTelemetry、OTLP、Prometheus 探针                    |

具体版本以 `package.json`、`pnpm-lock.yaml` 和 `services/ai-runtime/pyproject.toml` 为准。

## 7. Codex 开发规则

### 7.1 跨端修改

1. 先阅读相邻需求、代码、契约和测试。
2. 明确业务状态、权限、失败分支和验收标准。
3. 跨端字段先修改 `packages/contracts` 及测试。
4. 数据变更增加新的 Prisma migration，不修改历史 migration。
5. API 实现授权、状态机、审计和幂等，再修改 Worker/Runtime 和前端。
6. 前端覆盖加载、空数据、失败、降级和权限状态。
7. 运行目标测试、包级测试和必要的端到端验证。

### 7.2 AI、数据和安全

- 企业知识进入模型前必须完成租户、组织和权限过滤。
- 知识回答保留来源和版本；证据不足时明确说明。
- Prompt、模型、知识策略、智能体和工具版本必须可追踪。
- 高风险或不可逆动作必须确认或审批，并具备超时、幂等、审计和结果核验。
- 权限在 API 和数据库执行，不能只依赖前端隐藏按钮。
- `.env`、连接串、API Key、Cookie、UserSig 和客户机密不得提交或写入日志。
- 当前工作区可能有其他任务的未提交修改；只修改本任务文件，不回滚或格式化无关内容。

### 7.3 知识库边界变更

1. 业务模块新增知识能力时，优先扩展传输中立的 Gateway DTO；不得向 Gateway 参数或返回值加入 Prisma、Qdrant、对象存储或内部类类型。
2. 管理端、桌面端和第三方系统调用知识公共 HTTP API；同进程后端模块注入 Gateway port；异步消费者只订阅 `packages/contracts` 发布的版本化知识事件。
3. 知识事件必须先定义 Zod 契约和版本，再写入 Outbox；破坏性字段变化发布新事件版本，不原地改变 `.v1` 语义。
4. 面向生产拆分时，为知识数据、Qdrant 和对象存储使用独立服务身份与最小权限凭据；业务服务身份不得持有这些基础设施凭据。
5. 任何需要修改知识边界归属、白名单或依赖方向的变更，都必须更新 `docs/adr/0008-knowledge-independent-business-boundary.md` 并运行架构测试。

### 7.4 产品与 UI

- 页面优先回答：目标是什么、进展如何、有什么风险、下一步做什么。
- 页面按钮区的可用操作直接以清晰命名的按钮展示，不使用“高级”等 `details/summary` 点击展开入口隐藏操作按钮。
- 字体、颜色、间距、圆角、阴影、控件尺寸和动效必须引用 `apps/admin/src/styles/design-tokens.css` 中登记的 Token，并同步维护 `docs/design-system/admin-ui-style-spec.md`；业务组件不得新增内联视觉样式或散落的颜色、字号和常规间距硬编码。
- 普通用户不需要理解 Run、Invocation、Queue、Provider 等内部概念。
- AI 建议必须允许确认、修改、拒绝或转人工。
- UI 修改后应运行并打开真实客户端检查；不能启动时明确报告阻塞。
- 不把页面存在、HTTP 200、排队成功或历史测试结果表述为“已经可用”。

## 8. 常用命令与完成标准

```powershell
# 安装
Copy-Item .env.example .env
pnpm install
pnpm setup:electron
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".\services\ai-runtime[dev]"

# 基础设施、数据库和启动
pnpm dev:infra
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm dev

# 质量检查
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format:check
pnpm db:validate
pnpm test:db
.\.venv\Scripts\python.exe -m pytest services\ai-runtime
.\.venv\Scripts\python.exe -m ruff check services\ai-runtime
```

当前项目仍是开发版本。Codex 完成任务时必须说明：

1. 实际实现或确认了什么业务能力。
2. 修改了哪些文件。
3. 实际运行了哪些测试、构建、迁移、启动或 UI 检查。
4. 哪些真实模型、IM、存储、工具、身份和生产场景仍未验证。
5. 产品或技术分析应更新已有 Markdown；没有合适文件时保存到 `docs/codex/YYYY-MM-DD-主题.md`。

主要参考：`README.md`、`docs/README.md`、`docs/BMS-AI_V2_实施计划.md`、`docs/BMS-AI_V2_验收矩阵.md`、`docs/企业AI协同平台-总体技术方案.md`、`企业协同智能系统_产品与技术方案_V3.1_业务闭环优化版.docx`。
