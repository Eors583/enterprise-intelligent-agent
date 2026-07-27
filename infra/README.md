# 本地基础设施

开发环境第一阶段只启动 PostgreSQL 与 Redis：

```powershell
Copy-Item .env.example .env
pnpm dev:infra
```

数据库是业务事实源；Redis 只承担缓存、限流和短期协调。AI Runtime 与 API 默认提供不依赖数据库的开发适配器，便于先验证端到端链路；切换到持久化适配器前必须运行 Prisma migration。

生产环境不得复用这里的密码、镜像浮动标签或端口暴露方式，生产基线以 `docs/企业AI协同平台-总体技术方案.md` 为准。

数据库保护与核心积压探针见 [数据库备份、恢复演练与核心告警](../docs/runbooks/数据库备份恢复与核心告警.md)。恢复脚本只允许写入显式命名的隔离演练库，并拒绝业务库和保留验收库。
