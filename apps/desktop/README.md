# 企业 AI 协同桌面端

Electron + React + TypeScript + Vite 桌面客户端。当前支持创建企业、登录、退出、安全保存多个账号和切换账号，并消费真实 bootstrap、会话和消息 API。

未配置后端、网络失败或响应不符合契约时会显示明确失败状态，不会回退到静态演示数据或伪造 AI 回答。

## 本地启动

1. 复制根 `.env.example` 为 `.env`；
2. 设置 `REPOSITORY_DRIVER=prisma` 和 `VITE_API_BASE_URL=http://127.0.0.1:3000`；
3. 运行 `pnpm dev:infra`、`pnpm db:migrate`、`pnpm db:seed`；
4. 运行 `pnpm install` 和 `pnpm setup:electron`；
5. 启动 API 后运行 `pnpm dev:desktop`。

非本机 API 必须使用 HTTPS。

检查命令：

```powershell
pnpm --filter @enterprise/contracts build
pnpm --filter @enterprise/desktop typecheck
pnpm --filter @enterprise/desktop test
pnpm --filter @enterprise/desktop build
```

## 登录和多账号

登录使用企业短地址、邮箱和密码。注册页的“创建企业”会新建独立租户、组织、根部门和首位企业所有者，不用于加入已有企业；已有企业成员由管理后台创建。

账号切换模型：

- access token 仅保存在 Electron Main 进程内存；
- refresh token 使用系统 `safeStorage` 加密后保存在用户数据目录；
- Renderer 只能看到账号展示信息和 `sessionId`，无法读取 token；
- Main 在 access token 即将过期或业务请求返回 401 时自动轮换 token；
- 切换账号前先刷新目标会话，刷新成功后才激活；
- 切换后丢弃旧账号迟到的业务响应；
- 退出时先尝试服务端吊销，再删除本地账号；离线时仍可本地退出。

如果系统安全存储不可用，或 Linux 只能使用 `basic_text` 后端，桌面端不会把 refresh token 持久化到磁盘，账号只在当前进程内有效。

## Bootstrap 契约

登录后客户端请求 `GET /api/v1/bootstrap`，响应体不包裹 `data`：

```ts
interface BootstrapPayload {
  tenant: { id: string; name: string };
  currentUser: { id: string; name: string; title?: string; avatarUrl?: string };
  navigation: Array<{ id: string; label: string }>;
  departments: Array<{
    id: string;
    name: string;
    parentId: string | null;
    memberCount: number;
  }>;
  members: Array<{
    id: string;
    name: string;
    title: string;
    departmentIds: string[];
    avatarUrl?: string;
    status: 'active' | 'inactive';
    agent: null | {
      id: string;
      name: string;
      status: 'online' | 'offline' | 'disabled';
      summary?: string;
    };
    capabilities: {
      canContactHuman: boolean;
      canContactAgent: boolean;
    };
  }>;
}
```

部门和成员来自 PostgreSQL。管理后台调整组织后，桌面端重新加载 bootstrap 即可获得新结构。客户端还会检查 ID 唯一性、部门父子引用、组织树环和成员部门引用。

## 会话与消息

- `GET /api/v1/conversations`：当前账号的 direct 会话；
- `POST /api/v1/conversations`：按真人或个人智能体创建/复用会话；
- `GET /api/v1/conversations/:id/messages`：消息账本；
- `POST /api/v1/conversations/:id/messages`：发送文本消息。

每次发送生成唯一 `clientMessageId`，同时写入请求体和 `Idempotency-Key`。失败重试复用原 ID，服务端返回同一条消息而不是重复写入。

当前采用窗口可见性自适应同步：窗口聚焦时当前会话约每 2 秒、会话列表约每 10 秒刷新；可见但失焦时降低频率；隐藏或最小化时暂停。重新聚焦或网络恢复会立即刷新。

AI 消息只有服务端返回 `sender.type = "agent"` 时才显示。当前 API 尚未调用 AI Runtime，因此向 Agent 发送消息不会自动生成回复。

## Electron 安全边界

- `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`；
- Renderer 无 Node.js、文件系统、Shell 或 token 访问权限；
- Preload 只暴露运行信息、认证操作和受白名单限制的业务请求；
- Main 校验 IPC 来源，并限制允许的 API 路径、方法和请求体大小；
- Main 拒绝新窗口、页面导航、WebView 和设备权限；
- CSP 只允许连接构建时配置的 API origin 和开发期 Vite/HMR origin；
- API Base URL 除本机开发外必须是 HTTPS origin，不能携带用户信息、查询或路径。

## 当前未完成

- OIDC/SAML、MFA、忘记密码、成员邀请和设备会话管理；
- 腾讯客户端 SDK/WebSocket、在线状态、群聊、消息分页、已读/撤回和富媒体；
- Agent 流式回复、引用、工具审批、Run 进度和取消；
- 托盘、系统通知、深链、自动更新和生产代码签名闭环。

认证、管理与 RAG 路线详见 [ADR-0005](../../docs/adr/0005-first-party-auth-admin-and-knowledge-governance.md)。
