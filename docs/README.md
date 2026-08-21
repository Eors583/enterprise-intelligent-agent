# 项目文档

本目录沉淀“企业 AI 协同平台”的产品、架构、开发和交付文档。

## 当前实现快照

已落地：

- Electron 首方登录、创建企业、退出和安全多账号切换；
- 独立 React 管理后台；
- 动态组织树、成员账号/角色/任职管理；
- 知识库、部门范围、文本/Markdown 文档、版本、归档和审计；
- NestJS 会话/消息 API、PostgreSQL 权威账本和强制 RLS；
- 可靠 IM Outbox Worker、Local/Tencent Provider 边界和桌面自动同步；
- 独立 AI Runtime 的 `noop | openai_compatible | manus` 驱动边界；
- PostgreSQL `AgentRun`、专用 Agent Run Outbox Worker 与员工到智能体回复闭环；
- 桌面端双智能体协作入口，以及显式 A/B、默认 4 轮、最多 8 轮的有限中继；
- 飞书通讯录单向同步的服务端配置边界、官方域名白名单、数据所有权和事务契约。

尚未落地：

- OIDC/SAML、SCIM、MFA、密码重置和正式账号邀请；
- 腾讯真实凭据、公网回调 Inbox、客户端 SDK/WebSocket 和群聊；
- 文件对象存储、解析/OCR、搜索、Embedding、向量索引和 RAG；
- API 到 AI Runtime 的服务身份、持久化 Runtime RunStore、引用和工具审批；
- Manus webhook/事件 Inbox、流式推送、`UNKNOWN` 自动对账和 credits 预算；
- 飞书通讯录事件回调、实时增量 Inbox、多连接管理和飞书 SSO；
- 生产密钥、部署、代码签名、可观测性和安全运营闭环。

重要语义：当前知识库已经接入权限内检索、Agent Run 知识注入和引用溯源；Embedding、pgvector 混合召回与 Reranker 是可选能力，未配置真实供应商或缺少当前模型向量证据时只能标记为“仅词法检索”，不得宣称企业级语义 RAG。Prisma 模式启用 Agent Run Worker 且 AI Runtime 配置有效 Provider 后，员工到智能体和 `agent_pair` 会话会自动触发后端 Run；桌面端只展示服务端持久化的真实回复。开发默认 `noop` 不会产生模型成功结果，Manus 内容会离开本平台安全边界。

飞书通讯录接入默认关闭，只允许 Nest API 服务端持有 App ID/App Secret，并通过 `FEISHU_DIRECTORY_TARGET_TENANT_SLUG` 显式绑定一个本地租户；MVP 是飞书到本平台的只读投影，不提供通讯录回写或飞书登录。

## 主方案

- [企业 AI 协同平台总体技术方案](./企业AI协同平台-总体技术方案.md)：桌面应用、后端、即时通信、协同、智能体、数据、安全、部署和实施路线的总体基线。
- [知识库能力评估与开源方案对照](./知识库能力评估与开源方案对照.md)：当前可用性结论、成熟开源方案差距、推荐架构与发布门禁。

## 已批准的工程决策

- [ADR-0001：Phase 1 工程基线](./adr/0001-phase-1-engineering-baseline.md)
- [ADR-0002：Phase 2 持久化与会话账本](./adr/0002-phase-2-persistence-and-conversation.md)
- [ADR-0003：数据库租户隔离与角色边界](./adr/0003-database-security-boundaries.md)
- [ADR-0004：可靠 IM Outbox、腾讯云适配器与桌面同步](./adr/0004-reliable-im-outbox-and-desktop-sync.md)
- [ADR-0005：首方认证、动态组织管理与知识库治理闭环](./adr/0005-first-party-auth-admin-and-knowledge-governance.md)
- [ADR-0006：Manus 智能体运行与有限轮次中继编排](./adr/0006-manus-agent-runtime-and-relay-orchestration.md)
- [ADR-0007：飞书通讯录单向同步与组织数据所有权](./adr/0007-feishu-directory-one-way-sync.md)

## 运行和组件说明

- [本地开发与数据库验证](./runbooks/本地开发与数据库验证.md)
- [企业知识库生产接线、验收与故障恢复](./runbooks/企业知识库生产接线与验收.md)
- [真实语义检索与企业问题集验收](./runbooks/真实语义检索与企业问题集验收.md)
- [数据库备份恢复与核心告警](./runbooks/数据库备份恢复与核心告警.md)
- [外部能力状态与无损数据治理](./runbooks/外部能力状态与无损数据治理.md)
- [API](../apps/api/README.md)
- [管理后台](../apps/admin/README.md)
- [桌面端](../apps/desktop/README.md)
- [AI Runtime](../services/ai-runtime/README.md)

后续文档继续按以下目录沉淀：

- `adr/`：已批准的架构决策；
- `api/`：OpenAPI、AsyncAPI 和回调协议；
- `data/`：物理模型、数据字典和数据分级；
- `runbooks/`：部署、发布、回滚、备份恢复和安全事件；
- `product/`：原型、用户旅程、权限矩阵和验收用例。
