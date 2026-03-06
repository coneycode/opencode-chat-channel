# opencode-feishu-bot

An [opencode](https://opencode.ai) plugin that connects your Feishu (Lark) bot to opencode via **WebSocket long connection** — no public IP required.

[中文说明](#中文说明) · [English](#english)

---

## English

### How It Works

```
Feishu User sends message
    ↓ WebSocket long connection
Feishu Open Platform
    ↓ @larksuiteoapi/node-sdk WSClient
feishu-bot plugin (this repo)
    ↓ client.session.prompt()
opencode AI (Sisyphus)
    ↓ text reply
Feishu User receives reply
```

- Each Feishu user (`open_id`) gets their own persistent opencode session
- Sessions expire after 2 hours of inactivity (auto-cleanup)
- Replies longer than 4000 characters are automatically split into multiple messages

### Installation

1. **Copy the plugin file** to your opencode plugins directory:

```bash
cp src/index.ts ~/.config/opencode/plugins/feishu-bot.ts
```

2. **Add the dependency** to `~/.config/opencode/package.json`:

```json
{
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.37.0"
  }
}
```

Then run `bun install` in `~/.config/opencode/`.

### Configuration

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
```

**App Secret** (sensitive, store in macOS Keychain):

```bash
security add-generic-password -a feishu-bot -s opencode-feishu-bot -w <your-app-secret> -U
```

Verify:

```bash
security find-generic-password -a feishu-bot -s opencode-feishu-bot -w
```

#### Step 3: Start opencode

```bash
opencode
```

You should see in the logs:

```
[feishu-bot] 飞书机器人已启动（长连接模式），appId=cli_xxx***
```

### File Structure

```
~/.config/opencode/
├── plugins/
│   └── feishu-bot.ts    # plugin file (copied from src/index.ts)
├── package.json          # dependencies (add @larksuiteoapi/node-sdk)
└── .env                  # FEISHU_APP_ID (App Secret in Keychain)
```

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
飞书用户发消息
    ↓ WebSocket 长连接
飞书开放平台
    ↓ @larksuiteoapi/node-sdk WSClient
feishu-bot 插件（本仓库）
    ↓ client.session.prompt()
opencode AI (Sisyphus)
    ↓ 回复文本
飞书用户
```

- 每个飞书用户（`open_id`）独享一个 opencode session，**对话历史持久保留**
- session 闲置 2 小时后自动回收，下次对话开新 session
- AI 回复超过 4000 字时自动分段发送

### 安装

1. **复制插件文件** 到 opencode 插件目录：

```bash
cp src/index.ts ~/.config/opencode/plugins/feishu-bot.ts
```

2. **添加依赖** 到 `~/.config/opencode/package.json`：

```json
{
  "dependencies": {
    "@larksuiteoapi/node-sdk": "^1.37.0"
  }
}
```

然后在 `~/.config/opencode/` 目录运行 `bun install`。

### 配置步骤

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
```

**App Secret**（敏感，存 macOS Keychain，不落盘明文）：

```bash
security add-generic-password -a feishu-bot -s opencode-feishu-bot -w <你的AppSecret> -U
```

验证写入是否成功：

```bash
security find-generic-password -a feishu-bot -s opencode-feishu-bot -w
```

#### 第三步：启动 opencode

```bash
opencode
```

启动后日志中会看到：

```
[feishu-bot] 飞书机器人已启动（长连接模式），appId=cli_xxx***
```

### 文件位置

```
~/.config/opencode/
├── plugins/
│   └── feishu-bot.ts    # 插件主文件（从 src/index.ts 复制）
├── package.json          # 依赖（含 @larksuiteoapi/node-sdk）
└── .env                  # 环境变量（FEISHU_APP_ID；App Secret 存 Keychain）
```

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
