# 管理后台 Lighthouse 优化记录

## 1. 输入与判断

- 输入报告：Lighthouse 13.4.0，目标页为 `http://127.0.0.1:4173/#members`。
- 报告基线：Performance 56、Accessibility 95、Best Practices 96、SEO 91；FCP 4.5 秒、LCP 8.6 秒、总传输约 8,245 KiB。
- 报告是在 Vite 开发服务器上生成的。`@vite/client`、React Refresh、开发版 React、源码模块和 WebSocket 会显著放大未压缩 JavaScript、未使用 JavaScript及 bfcache 告警，因此生产验收必须使用 `vite preview` 或正式部署地址。
- 报告仍暴露了真实产品问题：业务页面被入口文件一次性加载、总契约入口牵连全部 Schema、成员页多处辅助文字对比度不足、`robots.txt` 被单页应用回退为 HTML。

## 2. 已实现的优化

### 2.1 首屏和路由加载

- 管理端 14 个业务页面改为 `React.lazy` 路由级按需加载，并使用统一加载态。
- 登录、账号恢复、修改密码弹窗改为延迟加载；已登录用户不再下载登录和恢复表单。
- 将认证、当前会话和成员管理 API 从单体 `admin-api` 入口拆出。
- 新增最小 `auth-session` 契约子入口；应用壳、会话恢复、请求刷新和导航权限不再从 `@enterprise/contracts` 总入口加载知识、评测、角色等无关契约。
- 知识库、评测和 PDF 相关资源只在进入对应页面时加载。

生产构建对比：

| 指标                          |         优化前 |                        优化后 |                       变化 |
| ----------------------------- | -------------: | ----------------------------: | -------------------------: |
| 应用壳入口 JavaScript         |      980.7 KiB |                    294.31 KiB |                     -70.0% |
| 应用壳入口 JavaScript gzip    |     未单独记录 |                     89.56 KiB |                          — |
| 成员页首次路由所需 JavaScript |     与入口合并 | 约 357.2 KiB / gzip 107.6 KiB | 含应用壳、成员页及共享契约 |
| 全局 CSS                      |      138.8 KiB |                     99.28 KiB |                     -28.5% |
| 成员页 JavaScript             |     与入口合并 |                     24.28 KiB |               独立按需加载 |
| 成员页 CSS                    | 与全局样式合并 |                      1.35 KiB |               独立按需加载 |

构建产物中的 PDF worker 仍约 1 MiB，但它不属于成员页首屏资源，只会在文档预览能力实际需要时加载。

### 2.2 可访问性与样式规范

- 调整 `--color-ink-500` 与 `--color-ink-400`，使小号辅助文字在白色、浅绿色和浅灰色背景上满足 WCAG AA 普通文字至少 4.5:1 的对比度要求。
- 成员页邮箱、职位、数量、表头、停用状态，以及租户标识、页头说明和二级导航说明统一使用语义 Token。
- 在管理端样式规范中登记对比度红线，并增加自动化对比度测试，避免后续重新引入过浅灰字。

### 2.3 SEO、缓存与安全

- 增加有效的 `public/robots.txt`。管理后台属于登录后内部系统，因此使用 `Disallow: /`，修复格式错误的同时明确禁止搜索引擎索引。
- 生产预览 HTML 从 `Cache-Control: no-store` 调整为 `no-cache, max-age=0, must-revalidate`，允许浏览器进行安全的重新验证，并消除生产场景由 HTML `no-store` 触发的 bfcache 阻断。
- 开发服务器继续使用 `no-store`，避免本地开发缓存旧页面。
- 没有为了 Lighthouse 的旧浏览器提示而给 `script-src` 增加 `unsafe-inline`。生产 CSP 保持 `script-src 'self'`；降低脚本安全边界不属于合理的评分优化。
- 报告中的开发 WebSocket bfcache 项只存在于 Vite HMR，不会进入生产预览。

## 3. 验证结果

- `@enterprise/contracts` 全量测试：43 个文件、235 项通过。
- `@enterprise/admin` 全量测试：68 个文件、239 项通过。
- 管理端 TypeScript 类型检查通过。
- 管理端生产构建通过，无超过 500 KiB 的入口 JavaScript 警告。
- 生产预览 `http://127.0.0.1:4273/#members` 成功使用既有登录会话打开，真实 API 返回 9 名成员，成员列表、筛选和操作按钮正常渲染。
- 生产预览的 HTML 响应为 200，缓存头为 `no-cache, max-age=0, must-revalidate`；CSP 为生产策略；`robots.txt` 返回 200、`text/plain` 和有效规则。
- 实际页面计算样式确认：页头说明为 `rgb(92, 112, 106)`，租户标识、表格数量和职位辅助文字为 `rgb(95, 113, 108)`，均已使用修正后的 Token。

## 4. 验收边界与后续建议

- 本次没有伪造一个“生产 Lighthouse 分数”。原报告包含登录态，命令行 Lighthouse 的全新浏览器配置无法复用该会话；最终分数应在生产预览或正式 HTTPS 地址中，以同一登录态重新执行一次 Lighthouse。
- 本地 `127.0.0.1` 的 HTTP 不代表生产传输策略。正式环境仍必须由网关或负载均衡器提供 HTTPS、压缩和静态资源长缓存。
- 全局 CSS 仍为 99.28 KiB，可在后续页面样式模块化工作中继续拆分；本轮已优先解决报告中影响最大的 JavaScript 和对比度问题。
