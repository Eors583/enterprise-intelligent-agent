# 企业 AI 协同管理后台

独立的浏览器管理端，用于维护企业组织架构、成员账号与知识库。管理端与桌面应用分离部署，所有业务请求均通过 `/api/v1` 后端接口完成。

## 本地启动

先启动 PostgreSQL、Redis 和 API 服务，再执行：

```powershell
pnpm --filter @enterprise/admin dev
```

默认访问 `http://127.0.0.1:4173`。Vite 开发服务器会将 `/api` 代理到 `http://127.0.0.1:3000`。

如需直连其他环境，在 `.env.local` 中设置：

```dotenv
VITE_API_BASE_URL=https://example.internal/api/v1
```

## 可用能力

- 管理员登录；创建企业并注册首位企业所有者。
- access token 失效后使用 refresh token 自动续期；会话保存在当前标签页的 `sessionStorage`，退出时服务端撤销并清理本地会话。
- 动态组织树：新建、改名、排序、移动和归档部门。
- 成员账号：创建初始账号，调整部门/职位、角色与账号状态。
- 知识库：创建、设置草稿/启用/归档状态、指定部门可见范围。
- 纯文本与 Markdown 知识文档：创建、编辑新版本与归档。

企业所有者（`OWNER`）和企业管理员（`ADMIN`）可以管理全部模块；知识管理员（`KNOWLEDGE_ADMIN`）仅展示知识库模块。最终授权仍由后端强制执行。

## 质量检查

```powershell
pnpm --filter @enterprise/contracts build
pnpm --filter @enterprise/admin typecheck
pnpm --filter @enterprise/admin test
pnpm --filter @enterprise/admin build
```

生产部署必须使用 HTTPS，并由反向代理将管理端与 API 放在受控域名下。当前 access/refresh token 保存在标签页 `sessionStorage`，适用于受控内网 MVP；公网部署应升级为同源 BFF 或 `Secure + HttpOnly + SameSite` Cookie，并补齐 CSP、CSRF 防护、限流和 MFA/SSO。

当前知识文档能力聚焦文本内容治理，不假定已经完成文件对象存储、解析、搜索、向量化或 RAG 索引。详细边界见 [ADR-0005](../../docs/adr/0005-first-party-auth-admin-and-knowledge-governance.md)。
