/**
 * opencode-chat-channel — 飞书渠道适配器
 *
 * 通过飞书长连接（WebSocket）接收消息，实现 ChatChannel 接口。
 *
 * 凭证读取优先级（FEISHU_APP_SECRET）：
 *   1. 环境变量 FEISHU_APP_SECRET（所有平台，最高优先）
 *   2. macOS Keychain（仅 macOS，自动尝试）
 *      service=opencode-chat-channel，account=chat-channel
 *      写入：security add-generic-password -a chat-channel -s opencode-chat-channel -w <secret> -U
 *   3. ~/.config/opencode/.env 中的 FEISHU_APP_SECRET（Windows/Linux 推荐）
 *
 * FEISHU_APP_ID 始终从 .env 文件读取（非敏感）。
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { execFileSync } from "child_process";
import type { ChatChannel, ChannelFactory, IncomingMessage, PluginClient } from "../../types.js";
import { fileLog } from "../../session-manager.js";

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** 飞书消息长度上限，超出后自动分段 */
const MAX_MSG_LEN = 4000;

/** 已处理消息 ID 集合的最大容量（防止无限增长） */
const MAX_PROCESSED = 500;

// ─── 凭证读取 ─────────────────────────────────────────────────────────────────

/**
 * 按优先级读取飞书 App Secret：
 *   1. process.env.FEISHU_APP_SECRET（环境变量，所有平台）
 *   2. macOS Keychain（仅 macOS）
 *   3. 返回 undefined（.env 文件中的值已在插件启动时注入 process.env，由第 1 步覆盖）
 */
function readAppSecret(): string | undefined {
  // 1. 环境变量（含 .env 注入后的值）
  if (process.env["FEISHU_APP_SECRET"]) {
    return process.env["FEISHU_APP_SECRET"];
  }

  // 2. macOS Keychain（仅在 macOS 上尝试，其他平台静默跳过）
  if (process.platform === "darwin") {
    try {
      const stdout = execFileSync(
        "security",
        ["find-generic-password", "-a", "chat-channel", "-s", "opencode-chat-channel", "-w"],
        { encoding: "utf8" }
      );
      return stdout.trim() || undefined;
    } catch {
      // Keychain 中没有此条目，继续
    }
  }

  return undefined;
}

// ─── FeishuChannel 实现 ───────────────────────────────────────────────────────

class FeishuChannel implements ChatChannel {
  readonly name = "feishu";

  private readonly larkClient: Lark.Client;
  private readonly processedMessages = new Set<string>();

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly client: PluginClient
  ) {
    this.larkClient = new Lark.Client({
      appId,
      appSecret,
      appType: Lark.AppType.SelfBuild,
      domain: Lark.Domain.Feishu,
    });
  }

  // ── ChatChannel.start ────────────────────────────────────────────────────

  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    const wsClient = new Lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: Lark.LoggerLevel.warn,
    });

    wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: any) => {
          const parsed = this.parseEvent(data);
          // 立即返回使飞书SDK能发出ACK，避免飞书超时重投递
          // onMessage 异步执行，已通过 parseEvent 内的去重保证不重复处理
          if (parsed) void onMessage(parsed);
        },
      }),
    });

    await this.client.app.log({
      body: {
        service: "chat-channel",
        level: "info",
        message: `[feishu] 飞书机器人已启动（长连接模式），appId=${this.appId.slice(0, 8)}***`,
      },
    });
  }

  // ── ChatChannel.send ─────────────────────────────────────────────────────

  async send(replyTarget: string, text: string): Promise<void> {
    // 飞书消息长度限制，超长时分段发送
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_MSG_LEN) {
      chunks.push(text.slice(i, i + MAX_MSG_LEN));
    }

    for (const chunk of chunks) {
      await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: replyTarget,
          content: JSON.stringify({ text: chunk }),
          msg_type: "text",
        },
      });
    }
  }

  // ── 思考进度消息（卡片，支持 patch 更新） ──────────────────────────────

  /**
   * 发送「正在思考」卡片占位消息，返回 message_id 用于后续 patch 更新。
   * 使用新版卡片格式（schema 2.0）+ collapsible_panel，支持 patch 更新内容。
   * update_multi:true 是 patch 更新的必要条件。
   */
  async sendThinkingCard(chatId: string): Promise<string | null> {
    const card = buildCard("⏳ 正在思考...", "", "thinking");
    try {
      const res = await this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify(card),
          msg_type: "interactive",
        },
      });
      const msgId = res.data?.message_id ?? null;
      fileLog("info", `[feishu] sendThinkingCard 成功: msgId=${msgId}`);
      return msgId;
    } catch (err) {
      const errStr = (err as any)?.response?.data ? JSON.stringify((err as any).response.data) : String(err);
      void this.client.app.log({
        body: {
          service: "chat-channel",
          level: "warn",
          message: `[feishu] sendThinkingCard 失败: ${errStr}`,
        },
      });
      // 同步写文件日志，确保错误可见
      fileLog("warn", `[feishu] sendThinkingCard 失败: ${errStr}`);
      return null;
    }
  }

  /**
   * 更新已发送的思考卡片内容（旧接口，向下兼容）。
   * @param messageId  sendThinkingCard 返回的 message_id
   * @param statusText 要显示的新状态文本
   */
  async updateThinkingCard(messageId: string, statusText: string): Promise<void> {
    const card = buildCard(statusText, "", "thinking");
    try {
      await this.larkClient.im.message.patch({
        data: { content: JSON.stringify(card) },
        path: { message_id: messageId },
      });
      fileLog("info", `[feishu] updateThinkingCard 成功: msgId=${messageId}`);
    } catch (err) {
      const errStr = (err as any)?.response?.data ? JSON.stringify((err as any).response.data) : String(err);
      void this.client.app.log({ body: { service: "chat-channel", level: "warn", message: `[feishu] updateThinkingCard patch 失败: ${errStr}` } });
      fileLog("warn", `[feishu] updateThinkingCard patch 失败: ${errStr}`);
    }
  }

  /**
   * 更新思考卡片为进度状态（reasoning / replying 阶段）。
   * 外部摘要可见，详情需点击展开。
   */
  async patchProgress(
    messageId: string,
    summary: string,
    detail: string,
    stage: "reasoning" | "replying"
  ): Promise<void> {
    const card = buildCard(summary, detail, stage);
    try {
      await this.larkClient.im.message.patch({
        data: { content: JSON.stringify(card) },
        path: { message_id: messageId },
      });
      fileLog("info", `[feishu] patchProgress 成功: msgId=${messageId} stage=${stage}`);
    } catch (err) {
      const errStr = (err as any)?.response?.data ? JSON.stringify((err as any).response.data) : String(err);
      void this.client.app.log({ body: { service: "chat-channel", level: "warn", message: `[feishu] patchProgress 失败: ${errStr}` } });
      fileLog("warn", `[feishu] patchProgress 失败: ${errStr}`);
    }
  }

  /**
   * 更新思考卡片为完成状态。
   * 卡片摘要变为"✅ 已完成"，detail 内容可展开查看。
   */
  async patchDone(messageId: string, detail: string): Promise<void> {
    const card = buildCard("✅ 已完成", detail, "done");
    try {
      await this.larkClient.im.message.patch({
        data: { content: JSON.stringify(card) },
        path: { message_id: messageId },
      });
      fileLog("info", `[feishu] patchDone 成功: msgId=${messageId}`);
    } catch (err) {
      const errStr = (err as any)?.response?.data ? JSON.stringify((err as any).response.data) : String(err);
      void this.client.app.log({ body: { service: "chat-channel", level: "warn", message: `[feishu] patchDone 失败: ${errStr}` } });
      fileLog("warn", `[feishu] patchDone 失败: ${errStr}`);
    }
  }

  // ── 内部工具 ─────────────────────────────────────────────────────────────

  /** 解析飞书事件，返回标准化 IncomingMessage；无效/重复消息返回 null */
  private parseEvent(data: any): IncomingMessage | null {
    const { message, sender } = data ?? {};
    if (!message || !sender) return null;

    // 只处理文本消息
    if (message.message_type !== "text") {
      // 发送提示后返回 null（调用方不会继续处理）
      void this.larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: message.chat_id,
          content: JSON.stringify({ text: "暂时只支持文本消息 😊" }),
          msg_type: "text",
        },
      });
      return null;
    }

    // 去重
    const msgId: string = message.message_id;
    if (this.processedMessages.has(msgId)) return null;
    if (this.processedMessages.size >= MAX_PROCESSED) this.processedMessages.clear();
    this.processedMessages.add(msgId);

    // 解析文本
    let text: string;
    try {
      text = (JSON.parse(message.content) as { text: string }).text?.trim();
    } catch {
      return null;
    }
    if (!text) return null;

    return {
      messageId: msgId,
      userId: sender.sender_id?.open_id ?? message.chat_id,
      replyTarget: message.chat_id,
      text,
    };
  }
}

// ─── 卡片构建工具 ─────────────────────────────────────────────────────────────

/**
 * 构建飞书新版卡片（schema 2.0），使用 header + body 结构。
 * header 标题始终可见（摘要），body markdown 展示详情（实时 patch 更新）。
 * update_multi:true 是 patch 更新的必要条件。
 */
function buildCard(
  summary: string,
  detail: string,
  stage: "thinking" | "reasoning" | "replying" | "done"
): object {
  const templates: Record<typeof stage, string> = {
    thinking: "blue",
    reasoning: "wathet",
    replying: "turquoise",
    done: "green",
  };
  const card: Record<string, unknown> = {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: summary },
      template: templates[stage],
    },
  };
  // 飞书 schema 2.0 要求 body 必须存在，detail 为空时用空占位
  card["body"] = {
    elements: detail ? [{ tag: "markdown", content: detail }] : [{ tag: "markdown", content: " " }],
  };
  return card;
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────────────

/**
 * 飞书渠道工厂函数。
 * 凭证不完整时记录警告日志并返回 null（插件跳过该渠道）。
 */
export const feishuChannelFactory: ChannelFactory = async (client: PluginClient) => {
  const appId = process.env["FEISHU_APP_ID"];
  const appSecret = readAppSecret();

  if (!appId || !appSecret) {
    const isMac = process.platform === "darwin";
    const secretHint = isMac
      ? "macOS: security add-generic-password -a chat-channel -s opencode-chat-channel -w <secret> -U\n" +
        "       或在 .env 中添加 FEISHU_APP_SECRET=<secret>"
      : ".env 中添加 FEISHU_APP_SECRET=<secret>";
    await client.app.log({
      body: {
        service: "chat-channel",
        level: "warn",
        message: !appId
          ? "[feishu] FEISHU_APP_ID 未设置，请在 .env 中添加 FEISHU_APP_ID=cli_xxx，飞书渠道已跳过"
          : `[feishu] FEISHU_APP_SECRET 未找到，飞书渠道已跳过。请配置：${secretHint}`,
      },
    });
    return null;
  }

  return new FeishuChannel(appId, appSecret, client);
};
