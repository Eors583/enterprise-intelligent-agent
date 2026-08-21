# 本地基础设施

开发环境第一阶段只启动 PostgreSQL 与 Redis：

```powershell
Copy-Item .env.example .env
pnpm dev:infra
```

数据库是业务事实源；Redis 只承担缓存、限流和短期协调。AI Runtime 与 API 默认提供不依赖数据库的开发适配器，便于先验证端到端链路；切换到持久化适配器前必须运行 Prisma migration。

生产环境不得复用这里的密码、镜像浮动标签或端口暴露方式，生产基线以 `docs/企业AI协同平台-总体技术方案.md` 为准。

数据库保护与核心积压探针见 [数据库备份、恢复演练与核心告警](../docs/runbooks/数据库备份恢复与核心告警.md)。恢复脚本只允许写入显式命名的隔离演练库，并拒绝业务库和保留验收库。

关联标识、结构化日志、Prometheus 指标/告警、生产连续性配置门禁和 RPO/RTO 报告契约见 [生产可观测性与灾备验收](../docs/runbooks/生产可观测性与灾备验收.md)。配置样例不执行真实云端复制或 PITR，只有供应商和演练证据才能关闭对应边界。

外部能力的诚实状态口径、飞书 Secret 轮换阻断，以及 Outbox/额度/图谱/候选投影的隔离库
只读治理评估见
[外部能力状态与无损数据治理](../docs/runbooks/外部能力状态与无损数据治理.md)。评估脚本没有
`Apply` 模式；在版本级投影账本和 schema-gap 聚合迁移冻结前必须 fail-closed。
