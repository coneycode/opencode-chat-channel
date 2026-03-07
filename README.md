# opencode-chat-channel

An [opencode](https://opencode.ai) plugin that connects instant messaging bots to opencode AI via a unified multi-channel architecture.

**Currently supported**: Feishu (Lark) via WebSocket long connection — no public IP required.  
**Skeleton ready**: WeCom (企业微信) — see `src/channels/wecom/index.ts`.

[中文说明](#中文说明) · [English](#english)

---

## English

### How It Works

```
User sends message (Feishu / WeCom / ...)
    ↓ Channel adapter (WebSocket / HTTP callback / ...)
chat-channel plugin (this repo)
    ↓ client.session.prompt()
opencode AI (Sisyphus)
    ↓ text reply
User receives reply
```

- Each user (`open_id` / user ID) gets their own persistent opencode session
- Sessions expire after 2 hours of inactivity (auto-cleanup)
- Replies longer than 4000 characters are automatically split

---

### Installation

Since this is an **opencode plugin**, opencode handles installation automatically via npm. No scripts needed.

#### Step 1: Add to `opencode.json`

Edit `~/.config/opencode/opencode.json` and add the plugin:

```json
{
  "plugin": [
    "opencode-chat-channel@latest"
  ]
}
```

opencode will pull and install the package automatically on next startup.

#### Step 2: Select channels to enable

Add `CHAT_CHANNELS` to `~/.config/opencode/.env` to control which channels are active:

```bash
# ~/.config/opencode/.env

# Enable Feishu only (recommended to start)
CHAT_CHANNELS=feishu

# Enable multiple channels at once
# CHAT_CHANNELS=feishu,wecom

# Leave unset or empty = auto mode: any channel with valid credentials starts automatically
# CHAT_CHANNELS=
```

Then configure credentials for each enabled channel (see sections below).

#### Step 3: Configure channel credentials

See the [Feishu Configuration](#feishu-configuration) section below.

---

### Feishu Configuration

#### Step 1: Create a Feishu Self-Built App

1. Visit [Feishu Open Platform](https://open.feishu.cn/app) and create a **self-built app**
2. Note your **App ID** and **App Secret**
3. Under "Add App Capabilities", enable **Bot**
4. Under "Permissions", add:
   - `im:message` (read/send messages)
   - `im:message.group_at_msg` (receive group @ messages, optional)
5. Under "Event Subscriptions":
   - Select **"Use long connection to receive events"** (no webhook URL needed)
   - Add event: `Receive Message v2.0` (`im.message.receive_v1`)
6. Publish the app version

#### Step 2: Store Credentials

**App ID** (non-sensitive, store in `.env`):

```bash
# ~/.config/opencode/.env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx

# Optional: custom opencode API URL (default: http://localhost:4321)
# OPENCODE_BASE_URL=http://localhost:4321
```

**App Secret** — choose the method for your platform:

| Platform | Method | Command |
|----------|--------|---------|
| macOS | Keychain (recommended) | `security add-generic-password -a chat-channel -s opencode-chat-channel -w <secret> -U` |
| Windows / Linux | `.env` file | Add `FEISHU_APP_SECRET=<secret>` to `~/.config/opencode/.env` |
| All platforms | Environment variable | Set `FEISHU_APP_SECRET=<secret>` before launching opencode |

> **Priority**: environment variable → macOS Keychain → `.env` file value (already loaded as env var).
> The plugin tries each in order and uses the first one found.

> ⚠️ If you store the secret in `.env`, ensure the file has restricted permissions:
> `chmod 600 ~/.config/opencode/.env`

**macOS Keychain** (verify):

```bash
security find-generic-password -a chat-channel -s opencode-chat-channel -w
```

#### Step 3: Start opencode

```bash
opencode
```

You should see in the logs:

```
[feishu] 飞书机器人已启动（长连接模式），appId=cli_xxx***
chat-channel 已启动，活跃渠道: feishu
```

---

### Adding a New Channel

The plugin uses a `ChatChannel` interface. To add a new channel:

1. Create `src/channels/<name>/index.ts` implementing `ChatChannel` and exporting a `ChannelFactory`
2. Register the factory in `src/index.ts` → `CHANNEL_FACTORIES` array

```typescript
// src/channels/myapp/index.ts
import type { ChatChannel, ChannelFactory } from "../../types.js";

class MyAppChannel implements ChatChannel {
  readonly name = "myapp";
  async start(onMessage) { /* connect, call onMessage on each msg */ }
  async send(target, text) { /* send reply */ }
}

export const myappChannelFactory: ChannelFactory = async (client) => {
  // read credentials, return null if not configured
  return new MyAppChannel(...);
};
```

```typescript
// src/index.ts — add to CHANNEL_FACTORIES
import { myappChannelFactory } from "./channels/myapp/index.js";

const CHANNEL_FACTORIES: ChannelFactory[] = [
  feishuChannelFactory,
  myappChannelFactory, // ← add here
];
```

---

### FAQ

**Q: Plugin starts but bot receives no messages**
- Ensure event subscription is set to "long connection", not "HTTP callback URL"
- Ensure the app version is published and online
- Verify App ID / Secret are correct

**Q: Replies are slow**
- AI processing takes time; complex tasks may need 10–30 seconds
- Simple conversations typically 3–8 seconds

**Q: How to reset conversation history**
- Restart opencode (sessions follow process lifecycle)
- Or wait 2 hours for session TTL to expire

---

## 中文说明

### 工作原理

```
用户发消息（飞书 / 企业微信 / ...）
    ↓ 渠道适配器（WebSocket 长连接 / HTTP 回调 / ...）
chat-channel 插件（本仓库）
    ↓ client.session.prompt()
opencode AI (Sisyphus)
    ↓ 回复文本
用户收到回复
```

- 每个用户独享一个 opencode session，**对话历史持久保留**
- session 闲置 2 小时后自动回收，下次对话开新 session
- AI 回复超过 4000 字时自动分段发送

---

### 安装

本项目是 **opencode 插件**，opencode 通过 npm 自动管理安装，无需额外脚本。

#### 第一步：添加到 `opencode.json`

编辑 `~/.config/opencode/opencode.json`，在 `plugin` 数组中添加：

```json
{
  "plugin": [
    "opencode-chat-channel@latest"
  ]
}
```

下次启动 opencode 时会自动拉取并安装。

#### 第二步：选择要启用的渠道

在 `~/.config/opencode/.env` 中配置 `CHAT_CHANNELS`，指定要开启哪些渠道：

```bash
# ~/.config/opencode/.env

# 只开启飞书（初始推荐）
CHAT_CHANNELS=feishu

# 同时开启多个渠道
# CHAT_CHANNELS=feishu,wecom

# 留空或不配置 = 自动模式：凭证存在的渠道自动启用
# CHAT_CHANNELS=
```

然后配置对应渠道的凭证（见下方各渠道配置说明）。

#### 第三步：配置渠道凭证

参见下方各渠道的配置说明。

---

### 飞书配置

#### 第一步：创建飞书自建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)，新建**企业自建应用**
2. 记录 **App ID** 和 **App Secret**
3. 在「添加应用能力」中开启**机器人**
4. 在「权限管理」中添加以下权限：
   - `im:message`（读取/发送消息）
   - `im:message.group_at_msg`（接收群组 @ 消息，按需）
5. 在「事件订阅」中：
   - 选择**使用长连接接收事件**（无需填写请求地址）
   - 添加事件：`接收消息 v2.0`（即 `im.message.receive_v1`）
6. 发布应用版本

#### 第二步：写入凭证

**App ID**（非敏感，明文存 `.env`）：

```bash
# ~/.config/opencode/.env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx

# 可选：自定义 opencode API 地址（默认：http://localhost:4321）
# OPENCODE_BASE_URL=http://localhost:4321
```

**App Secret**—按使用的平台选择存储方式：

| 平台 | 方式 | 命令 |
|------|------|------|
| macOS | 钒匙串（推荐，不落盘明文） | `security add-generic-password -a chat-channel -s opencode-chat-channel -w <secret> -U` |
| Windows / Linux | 写入 `.env` 文件 | 在 `~/.config/opencode/.env` 中添加 `FEISHU_APP_SECRET=<secret>` |
| 所有平台 | 环境变量 | 启动 opencode 前设置 `FEISHU_APP_SECRET=<secret>` |

> **读取优先级**：环境变量 → macOS 钒匙串 → `.env` 文件（已在插件启动时自动读入环境变量）。
> 插件依次尝试，找到第一个有效值即停止。

> ⚠️ 如果将 Secret 写入 `.env`，建议限制文件权限：
> `chmod 600 ~/.config/opencode/.env`

**macOS 钒匙串**验证：

```bash
security find-generic-password -a chat-channel -s opencode-chat-channel -w
```

#### 第三步：启动 opencode

```bash
opencode
```

启动后日志中会看到：

```
[feishu] 飞书机器人已启动（长连接模式），appId=cli_xxx***
chat-channel 已启动，活跃渠道: feishu
```

---

### 接入新渠道

插件基于 `ChatChannel` 接口设计，新增渠道步骤：

1. 新建 `src/channels/<渠道名>/index.ts`，实现 `ChatChannel` 接口并导出 `ChannelFactory`
2. 在 `src/index.ts` 的 `CHANNEL_FACTORIES` 数组中注册工厂函数

参见 `src/channels/wecom/index.ts` — 企业微信骨架，含详细的实现 TODO 注释。

---

### 项目结构

```
src/
├── index.ts                    # 插件入口，注册所有渠道
├── types.ts                    # ChatChannel 接口 & 公共类型
├── session-manager.ts          # opencode session 管理 & 工具函数
└── channels/
    ├── feishu/
    │   └── index.ts            # 飞书渠道实现（已完成）
    └── wecom/
        └── index.ts            # 企业微信渠道骨架（待实现）
```

---

### 常见问题

**Q: 插件启动后收不到消息**
- 确认飞书应用事件订阅选择的是「长连接」而非「HTTP 请求地址」
- 确认应用已发布且版本已上线
- 确认 App ID/Secret 正确

**Q: 回复很慢**
- AI 处理需要时间，复杂问题可能需要 10-30 秒
- 简单对话通常 3-8 秒

**Q: 想重置对话历史**
- 关闭 opencode 重启即可（session 随进程生命周期）
- 或等待 2 小时 session 超时自动重置

---

## License

MIT
