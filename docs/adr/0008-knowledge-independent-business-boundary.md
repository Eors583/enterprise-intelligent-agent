# ADR-0008：知识库独立业务边界

- 状态：Accepted
- 日期：2026-08-06
- 决策所有者：BMS-AI 架构

## 背景

企业知识能力同时被员工智能体、项目执行、评测、管理后台、经验沉淀和第三方系统使用。如果这些消费者直接读取 PostgreSQL 知识表、Qdrant collection、对象存储目录或知识内部类，知识库就无法独立升级、单独扩容、更换检索引擎或拆成远程服务，权限过滤也会分散到多个调用方。

因此，知识库不是“若干共享表和工具函数”，而是拥有数据、规则、存储适配器和发布协议的独立业务边界。

## 决策

采用以下红线：

> 任何智能体、项目、评测、管理端或第三方系统，只能通过 Knowledge Gateway、公共 API 或正式事件协议使用知识能力；不得直接访问知识库表、Qdrant collection、对象存储目录或内部实现类。

### 唯一允许的三类入口

| 调用场景                           | 允许入口                                                                      | 说明                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| NestJS 同进程业务模块              | `KnowledgeGateway`、`KnowledgeRetrievalGateway`、`KnowledgeEvaluationGateway` | 参数必须显式携带租户、用户和授权上下文；DTO 必须传输中立                             |
| 管理端、桌面端、第三方系统         | 由知识边界 controller 暴露的公共 HTTP API                                     | 前端和外部系统不能调用 NestJS 内部类，也不能取得基础设施凭据                         |
| Worker、评测流水线和其他异步消费者 | `packages/contracts` 中带版本号的知识事件                                     | 事件经 Outbox 发布；消费者不得通过事件中的 ID 反查知识表，只能再调用公共 API/Gateway |

`KnowledgeGateway` 的本地实现目前是进程内适配器。未来改成 HTTP/gRPC 适配器时，业务调用方契约保持不变。

### 所有权和依赖方向

```text
智能体 / 项目 / 评测 / 管理应用 / 第三方
                    │
        ┌───────────┼───────────┐
        ▼           ▼           ▼
 Knowledge Gateway  公共 API   正式事件协议
        │           │           ▲
        └──────┬────┘           │ Outbox
               ▼                │
        知识应用与领域服务 ──────┘
         │        │        │
         ▼        ▼        ▼
   PostgreSQL   Qdrant   S3/MinIO
   知识数据       向量索引   原始文件
```

依赖只能从上向下。知识边界拥有：

- `apps/api/src/modules/knowledge-gateway/`
- `apps/api/src/modules/knowledge-ingestion/`
- `apps/api/src/modules/knowledge-provider/`
- `apps/api/src/modules/knowledge-retrieval/`
- `apps/api/src/modules/knowledge-search-index/`
- `apps/api/src/modules/knowledge-semantic/`
- `apps/api/src/modules/knowledge-graph-governance/`
- 当前仍位于 `admin/` 下、但在架构测试中逐文件登记的知识管理 controller/service/helper；后续可物理迁入 `knowledge-administration/`，不能把整个 `admin/` 目录加入白名单。

### 明确禁止

边界外代码不得：

1. 调用 `transaction.knowledgeDocument`、`prisma.knowledgeChunk` 等知识 Prisma model。
2. 通过 `$queryRaw`/`$executeRaw` 查询或修改 `knowledge_*` 表。
3. 导入 ingestion、retrieval、semantic、search-index 或 graph-governance 的内部 service、repository、adapter、policy 或 domain helper。
4. 读取 `KNOWLEDGE_QDRANT_URL`、collection 名、Qdrant API Key，或直接请求 `/collections/...`。
5. 获取知识对象存储 key、本地目录、S3/MinIO bucket 凭据，或导入 `KnowledgeObjectStore` 实现。
6. 在公共 Gateway 类型中暴露 `Prisma.TransactionClient`、Prisma record、Qdrant point、collection 名或对象存储 key。
7. 为了跨边界原子性共享数据库 transaction。调用方必须使用版本、内容哈希、治理哈希、幂等键和事件实现并发控制及最终一致性。

### 公开契约

Gateway 当前分为：

- `KnowledgeRetrievalGateway`：检索、证据可访问性复核、知识选择校验和只读投影。
- `KnowledgeEvaluationGateway`：只返回版本化、不透明的评测快照和受治理语料；评测代码不理解知识表结构。
- `KnowledgeGateway`：在只读能力之上提供上传、入库、重试、索引/图谱重建、版本创建和受控原文读取。

正式事件由 `packages/contracts/src/knowledge-events.ts` 定义，当前 `.v1` 包括文档解析审核、治理更新、治理审核、版本发布、来源同步成功和来源同步失败。事件写入 Outbox 前必须通过 Zod 校验。破坏性变化发布 `.v2`，不得修改 `.v1` 的既有语义。

### 四类并列知识空间

知识边界内部把知识库归入四个同级根空间，而不是把它们串成“公司 → 部门 → 项目 → 成员”的父子链：

```text
企业知识空间
├─ 公司知识 ── 企业 ── 知识库 ── 文档
├─ 部门知识 ── 部门 ── 知识库 ── 文档
├─ 项目知识 ── 项目 ── 知识库 ── 文档
└─ 成员知识 ── 成员 ── 知识库 ── 文档
```

每个知识库拥有 `spaceType`、`spaceTargetId` 和 `spaceTargetName`。这三个字段属于知识边界：外部项目、组织或成员模块不得直接读取、写入或联表查询它们；需要按业务对象使用知识时，应扩展 Knowledge Gateway 的传输中立契约，由知识边界完成对象引用解析、租户过滤和知识授权。

知识归属与检索权限是正交概念：

- 归属空间回答“资料在树上放在哪里、属于哪个业务对象”。
- 知识库可见范围、文档治理状态和调用者授权回答“谁能检索到它”。
- 把资料归入某个成员空间不等于仅该成员可见；把资料归入公司空间也不等于全员自动可见。

知识访问范围同样由知识边界拥有并强制执行：

- `knowledge_base_org_units` 保存部门访问目标和是否包含下级部门。
- `knowledge_base_members` 保存显式成员访问目标；外部成员、智能体和项目模块不得直接查询该表。
- 两类访问目标都为空表示全公司有效成员可访问；任一访问目标存在时进入受限模式，命中任一部门或任一指定成员即可访问。
- 指定成员必须是当前租户中启用且具有有效任职关系的成员；前端名单不是授权事实来源。
- 检索候选、Agent Run 证据复核和引用原文读取都必须使用当前用户 ID、有效任职部门和最新知识范围重新校验，不能复用过期的前端判断。
- 上传到已有知识库的文件和新版本继承该知识库访问范围；若未来增加文档级例外，必须通过新的 Gateway DTO、前向迁移和明确的合并优先级实现，不能在业务模块里绕过知识库范围。

公司、部门和成员目标由知识管理 API 在写入时使用租户、组织单元和成员的正式身份校验并保存显示名快照。当前项目业务模块尚未提供权威 Project 实体，因此项目空间由知识边界生成稳定 UUID 并按名称复用；未来 Project 模块落地后，只能通过 Gateway/API 绑定其正式项目 ID，不能直接给知识表增加跨边界外键或从项目代码访问知识表。

## 强制机制

### 当前已经执行

- `knowledge-boundary.architecture.spec.ts` 扫描生产模块，阻止内部知识包导入、Prisma 知识模型访问、知识原始 SQL、Qdrant/Object Store 直连。
- 同一测试扫描外部 knowledge smoke 工具，要求验收只调用公共 API。
- Gateway public port 单独检查，禁止 Prisma 和知识内部实现类型泄漏。
- 管理概览、智能体配置、角色蓝图、组织删除校验、飞书目录同步、Agent Run、AI 评测和经验投影改为调用 Gateway。
- Agent Run 的证据复核不再向 Gateway 传递 Prisma transaction；知识边界自行建立读取事务。
- 知识 Outbox 事件使用共享 Zod 合同在写入前校验。
- 知识管理契约、数据模型和管理端树使用四类同级知识空间；历史知识库迁移时只补充公司归属，不改变原有可见范围和检索行为。
- 知识管理 API 支持全公司、指定部门和指定成员访问范围；成员范围由知识边界持久化，检索和引用链路在服务端执行最新范围复核。
- 外部知识提供方连接由 `knowledge-provider` 边界拥有。管理端只能调用其公共 HTTP API；AppSecret 使用租户、供应商和 AppKey 绑定的 AES-GCM 密文保存，连接状态响应不得返回明文凭据或 access token。
- 乐享托管知识库的远端身份由 `knowledge-provider` 边界内的 `KnowledgeExternalSpaceBinding` 拥有；绑定只保存稳定远端 ID、同步状态和非敏感展示元数据，不向边界外暴露凭据或供应商内部客户端。
- 乐享知识节点身份由同一边界内的 `KnowledgeExternalEntryBinding` 拥有；该映射只保存目录对账需要的远端节点、父节点和本地文件夹/文档稳定 ID。管理端通过知识公共 API 查看本地目录投影，其他业务模块不得直接读取映射表或导入乐享客户端。目录投影不包含远端正文，也不能在未经过 `KnowledgeRetrievalGateway` 授权与证据复核时参与智能体检索。
- 乐享 `operatorStaffId` 是同一知识 provider 边界内的连接级 API 访问身份，不映射 BMS 用户，也不授予 BMS 知识权限。正式检索必须先按当前 BMS 用户、有效任职和知识库范围得到可访问知识库，再把每个授权乐享库转换为明确的单一空间 target；召回后和 Agent Run 派发前继续按本地 ACL 复核。连接访问身份、凭据、空间绑定、本地用户任职或本地 ACL 任一失效时必须 fail closed，禁止省略 target 搜全站或改用 system-bot。
- 关闭可选本地知识后端只停止本地解析、向量化和本地索引，不得关闭外部 provider 路由。`KnowledgeRetrievalGateway` 仍负责解析本地权威知识库 ACL、显式限定外部空间 target、执行查询外发分类门禁，并在 Agent Run 派发前重新校验请求者身份、知识范围和 provider 绑定。外部 provider 不得被 Agent Run 或前端直接调用。
- 乐享文件夹和文件写入也由 `knowledge-provider` 边界拥有。管理 API 只传递已通过知识库写权限校验的目录路径与短生命周期文件字节；适配器负责校验外部绑定状态、创建远端目录、申请临时上传参数、限定 HTTPS 腾讯云 COS 目标、写入文件并关联稳定远端节点。COS 临时 URL、安全令牌和文件正文不得持久化或进入审计；本地只保存不含正文、对象存储键、内容版本和切片的目录影子。
- 乐享托管库在远端固定创建为不可见、团队管理员不继承、团队成员不继承，仅配置的操作成员拥有管理权限；公司/部门/成员访问范围仍以本地 `knowledge_base_org_units` 和 `knowledge_base_members` 为授权事实，并在检索时重新校验。
- 远端创建与本地事务不共享数据库事务：本地先保持 `DRAFT`，远端创建、详情读取和身份绑定成功后才激活。远端名称携带本地知识库 UUID 管理标记，响应丢失时先分页对账再决定是否创建，避免盲目重试产生重复知识库。
- 删除采用远端优先的补偿顺序：先删除绑定的乐享知识库，成功或确认 404 后才将本地知识库归档；远端失败时本地记录与权限事实保持不变并记录可重试状态和审计。

### 生产部署必须继续执行

代码架构测试能阻止正常开发路径越界，但同进程、同数据库账号部署不能在数据库层阻止恶意或遗漏的原始 SQL。因此生产服务化阶段必须增加第二层隔离：

- 知识服务使用独立数据库角色（例如 `knowledge_owner`）；业务 API 角色撤销 `knowledge_*` 表的直接 DML/SELECT。
- Qdrant API Key 只挂载给知识检索/索引运行单元，并限制到知识 collections。
- S3/MinIO 凭据只挂载给知识入库/原文服务，并限制到知识 bucket/prefix。
- 第三方仅获得公共 API 的 OAuth/服务账号，不获得数据库、Qdrant 或对象存储凭据。
- 监控数据库审计、Qdrant 访问日志和对象存储访问日志，发现非知识服务身份访问即告警。

在完全拆为独立进程前，本项目把“CI 架构测试 + 精确模块所有权 + Gateway 契约”作为第一层硬边界；不能将其描述为已经具备生产网络级或数据库账号级物理隔离。

## 变更流程

若新需求无法通过现有 Gateway/API/事件表达：

1. 先说明业务用例、租户与权限语义、失败分支、幂等和一致性要求。
2. 扩展传输中立的公共 DTO/契约，并补充契约测试。
3. 在知识边界内部实现适配器。
4. 更新此 ADR；若要增加边界拥有文件，逐文件登记原因。
5. 运行 contracts、API 类型检查、架构测试和相关集成测试。

不得以“临时查询”“只读报表”“评测方便”或“同一个数据库”为理由绕过 Gateway。

## 后果

收益：知识模型、Embedding、Qdrant、对象存储和解析实现可以独立替换；权限和来源版本语义集中；消费者更容易测试；未来可平滑拆分远程知识服务。

代价：跨边界不再共享事务；部分统计和评测需要专用只读 DTO；新增知识能力必须先设计公共契约；在服务物理拆分后需要处理网络失败、超时、重试和最终一致性。
