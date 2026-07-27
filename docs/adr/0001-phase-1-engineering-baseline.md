# ADR-0001：Phase 1 工程基线

- 状态：Accepted / Implemented
- 日期：2026-07-14
- 复审：Phase 0 POC 完成后

## 决策

1. 使用 pnpm workspace + Turborepo 管理 TypeScript Monorepo。
2. Node.js 24、TypeScript 5.9 作为新工程基线；TypeScript 7 待 Nest/Jest/Electron 构建链完成兼容验证后再升级。
3. Electron + React/Vite 构建桌面端，NestJS 构建模块化单体 API。
4. Python 3.12 + FastAPI 构建独立 AI Runtime。
5. `@enterprise/contracts` 保存跨进程 HTTP/事件契约，运行时使用 Zod 校验。
6. PostgreSQL 是事务事实源，Redis 仅用于非事实状态。
7. 第一条垂直链路使用可替换的内存开发适配器；生产适配器不得复用内存实现。

## 原因

当前项目只有需求与技术方案。先建立可构建、可测试、端到端可运行的边界，比同时实现全部业务域更能降低返工风险。内存适配器允许 UI、契约与服务边界先闭环，Prisma schema 同步定义未来持久化模型。

## 后果

- 本 ADR 建立基线时尚缺少数据库 migration 与模型适配器；两者已在后续 ADR-0002/0003 和 AI Runtime 垂直切片中部分落地。正式认证、腾讯云 IM、持久化 AI Run 和生产交付闭环仍未完成。
- 所有开发适配器必须通过接口隔离并在生产启动时拒绝启用。
- Electron、腾讯 IM、搜索与 WorkBuddy 仍按总体方案执行 Phase 0 POC 门禁。
