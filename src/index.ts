/**
 * opencode-chat-channel — opencode 多渠道机器人插件
 *
 * 支持多个即时通讯渠道同时运行，每个渠道独立处理消息。
 * 当前已实现：飞书（Feishu/Lark）
 * 骨架已创建：企业微信（WeCom）
 *
 * 凭证加载：
 *   FEISHU_APP_ID 等非敏感凭证存放在 ~/.config/opencode/.env
 *   敏感凭证存放在 macOS Keychain（各渠道独立 service/account）
 *
 * 每个渠道用户独享一个 opencode session，对话历史保留 2 小时。
 */

import type { Plugin } from "@opencode-ai/plugin";
import { join } from "path";
import { loadDotEnv, SessionManager, extractResponseText } from "./session-manager.js";
import { feishuChannelFactory } from "./channels/feishu/index.js";
import { wecomChannelFactory } from "./channels/wecom/index.js";
import type { ChannelFactory, ChatChannel, IncomingMessage, PluginClient } from "./types.js";

// ─── opencode AI 配置 ─────────────────────────────────────────────────────────

/** opencode API 地址（本地默认）*/
const OPENCODE_BASE_URL = process.env["OPENCODE_BASE_URL"] ?? "http://localhost:4321";

// ─── 注册渠道列表 ─────────────────────────────────────────────────────────────

/**
 * 在此添加新渠道工厂函数即可接入新渠道。
 * 工厂函数返回 null 时，插件会静默跳过该渠道。
 */
const CHANNEL_FACTORIES: ChannelFactory[] = [
  feishuChannelFactory,
  wecomChannelFactory,
  // 新渠道示例：
  // dingtalkChannelFactory,
  // slackChannelFactory,
];

// ─── 消息处理核心 ─────────────────────────────────────────────────────────────

/**
 * 为指定渠道创建消息处理函数。
 * 每个渠道拥有独立的 SessionManager（用户 session 互不干扰）。
 */
function createMessageHandler(
  channel: ChatChannel,
  sessionManager: SessionManager,
  client: PluginClient
) {
  return async (msg: IncomingMessage): Promise<void> => {
    const { userId, replyTarget, text } = msg;

    await client.app.log({
      body: {
        service: "chat-channel",
        level: "info",
        message: `[${channel.name}] 收到消息: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`,
        extra: { userId, replyTarget },
      },
    });

    // 先发"正在思考"（若渠道支持）
    if ("sendThinking" in channel && typeof (channel as any).sendThinking === "function") {
      await (channel as any).sendThinking(replyTarget);
    }

    let responseText: string | null = null;
    try {
      const sessionId = await sessionManager.getOrCreate(userId);

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
          model: {
            providerID: "Mify-Anthropic",
            modelID: "ppio/pa/claude-sonnet-4-6",
          },
        },
      });

      responseText = extractResponseText(result.data?.parts ?? []);
    } catch (err: unknown) {
      const errorMsg =
        (err as any)?.data?.message ?? (err as any)?.message ?? String(err);

      await client.app.log({
        body: {
          service: "chat-channel",
          level: "error",
          message: `[${channel.name}] 处理消息失败: ${errorMsg}`,
          extra: { userId },
        },
      });
      await channel.send(replyTarget, `⚠️ 出错了：${errorMsg}`);
      return;
    }

    // try/catch 外发送回复，避免发送失败时再触发错误消息
    await channel.send(
      replyTarget,
      responseText || "（AI 没有返回文字回复）"
    );
  };
}

// ─── 插件主体 ─────────────────────────────────────────────────────────────────

export const ChatChannelPlugin: Plugin = async ({ client }) => {
  // 加载 .env 文件（opencode 不会自动注入）
  const configDir = join(
    process.env["HOME"] ?? `/Users/${process.env["USER"] ?? "unknown"}`,
    ".config",
    "opencode"
  );
  loadDotEnv(join(configDir, ".env"));

  // 初始化所有渠道
  const channels: ChatChannel[] = [];
  for (const factory of CHANNEL_FACTORIES) {
    const channel = await factory(client);
    if (channel) channels.push(channel);
  }

  if (channels.length === 0) {
    await client.app.log({
      body: {
        service: "chat-channel",
        level: "warn",
        message: "所有渠道均未就绪（凭证缺失或未配置），插件空启动。",
      },
    });
    return {};
  }

  // 为每个渠道启动独立的消息监听和 session 管理
  const cleanupTimers: ReturnType<typeof setInterval>[] = [];

  for (const channel of channels) {
    const sessionManager = new SessionManager(
      client,
      channel.name,
      (userId) => `${channel.name} 对话 · ${userId}`
    );

    const timer = sessionManager.startAutoCleanup();
    cleanupTimers.push(timer);

    const handleMessage = createMessageHandler(channel, sessionManager, client);
    await channel.start(handleMessage);
  }

  await client.app.log({
    body: {
      service: "chat-channel",
      level: "info",
      message: `chat-channel 已启动，活跃渠道: ${channels.map((c) => c.name).join(", ")}`,
    },
  });

  // ── 插件钩子 ─────────────────────────────────────────────────────────────

  return {
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type === "session.error") {
        await client.app.log({
          body: {
            service: "chat-channel",
            level: "warn",
            message: "opencode session 出现错误",
            extra: event.properties as Record<string, unknown>,
          },
        });
      }
    },
  };
};

export default ChatChannelPlugin;

// 导出类型和工具，供自定义渠道实现使用
export type { ChatChannel, ChannelFactory, IncomingMessage, PluginClient } from "./types.js";
export { SessionManager, extractResponseText, loadDotEnv } from "./session-manager.js";
