# SCIM 2.0 企业接线与验收

## 1. 仓库内协议边界

SCIM 基础路径为 `/api/v1/scim/v2/{connectorKey}`。每个连接器使用独立、不透明的
`ea_scim_...` Bearer capability；服务端只在 HMAC 摘要命中后设置 transaction-local
`app.tenant_id`，资源读写仍受连接器、租户、scope、RLS、审计与 Outbox 约束。

当前仓库内闭环包括：

- Users、Groups 的读取、创建、替换、Patch、停用/删除和弱 ETag CAS；
- exact-match filter、分页，以及 allowlist 限定的 `sortBy`/`sortOrder`；排序字段不会拼接
  客户端 SQL，并始终追加 `scim_id ASC` 稳定次序；
- `/Bulk` 最多 100 个操作、98,304 字节，请求必须携带 `Idempotency-Key`；所有操作逐项
  返回状态，达到 `failOnErrors` 后未执行项显式返回 424，不得静默部分成功；
- Bulk 在执行首个写入前统一验证请求所需 scope。当前不支持 `bulkId:` 跨操作引用，检测到
  引用时以 `400 invalidValue` 明确失败，不能猜测或错绑资源；
- 成功和错误正文均使用 `application/scim+json`；错误采用 SCIM Error schema；
- SCIM 不承担本地密码分发。Create、Replace、Patch 或 Bulk 任何层级出现
  `password` 都以 `400 mutability` fail-closed，并提示使用一次性邀请或企业 SSO 激活；
  历史扩展属性中即使存在大小写变体的 password 字段也不会回显。

`ServiceProviderConfig` 对外声明 Bulk、filter、sort、ETag 和 Patch 已支持，
`changePassword.supported=false`。

## 2. 生产接线

1. 在管理端创建连接器，完成 maker-checker 审核并发布为 `ACTIVE`。
2. 仅签发实际需要的 `scim.users.*`、`scim.groups.*` scope；令牌明文只展示一次。
3. 把基础 URL、令牌和允许的排序/filter 能力配置到企业 IdP，禁止在工单、日志或截图中
   记录令牌。
4. SCIM 创建的无密码成员必须通过唯一工作邮箱的一次性邀请，或已批准的企业 SSO 激活。
5. 先在隔离租户执行用户创建、组成员变更、停用、幂等重放、旧 ETag、错 scope、错
   connector、跨租户、Bulk 部分失败和离职回收负向用例，再逐步放量。

## 3. 验收口径

仓库单元/HTTP 测试只能证明协议解析、能力 scope、租户查询条件、幂等键、排序白名单、密码
fail-closed 和 SCIM 媒体类型。以下证据仍必须由真实 IdP 联网验收，不能以 Mock 代替：

- IdP 实际发送的 schema、Patch、Bulk、分页、排序和错误重试行为与本实现兼容；
- 同一企业 IdP 的新增、调岗、组变更、停用及重放不会串租户或重复开户；
- 令牌轮换/吊销后旧令牌立即失效，SIEM 能收到预期审计与告警；
- 大批量同步在 IdP 的速率限制、超时和重试策略下满足企业 SLA；
- IdP 不发送密码；若错误发送，IdP 能识别 `400 mutability` 并转入邀请/SSO 激活流程。

真实 IdP、生产密钥、目标网络和 SIEM 未接线时，企业身份总体状态必须保持
`实施中 + 外部验收`，不得宣称生产通过。
