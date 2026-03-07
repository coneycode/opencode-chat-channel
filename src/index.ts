/**
 * opencode-chat-channel — opencode 多渠道机器人插件
 *
 * 通过 .env 文件中的 CHAT_CHANNELS 配置项选择启用哪些渠道：
 *
 *   CHAT_CHANNELS=feishu          # 只启用飞书
 *   CHAT_CHANNELS=feishu,wecom    # 同时启用飞书和企业微信
 *   CHAT_CHANNELS=                # 留空：自动探测（凭证存在即启用）
 *   # 不配置此项：同留空，自动探测
 *
 * 其他配置项：
 *   OPENCODE_BASE_URL   opencode API 地址（默认 http://localhost:4321）
 *
 * 各渠道的凭证配置详见 README。
 */

import type { Plugin } from "@opencode-ai/plugin";
import { join } from "path";
import { loadDotEnv, SessionManager, extractResponseText } from "./session-manager.js";
import { feishuChannelFactory } from "./channels/feishu/index.js";
import { wecomChannelFactory } from "./channels/wecom/index.js";
import type { ChannelFactory, ChannelName, ChatChannel, IncomingMessage, PluginClient } from "./types.js";

// ─── 渠道注册表 ───────────────────────────────────────────────────────────────

/**
 * 所有可用渠道的注册表。
 * 新增渠道时：
 *   1. 在 src/channels/<name>/index.ts 实现 ChatChannel 接口
 *   2. 在 src/types.ts 的 ChannelName 联合类型中添加名称
 *   3. 在此处注册工厂函数
 */
const CHANNEL_REGISTRY: Record<ChannelName, ChannelFactory> = {
  feishu: feishuChannelFactory,
  wecom: wecomChannelFactory,
};

// ─── 渠道选择 ─────────────────────────────────────────────────────────────────

/**
 * 根据 CHAT_CHANNELS 环境变量解析用户期望启用的渠道。
 *
 * 规则：
 *   - 未设置 / 空值 → 返回 null（自动模式：尝试所有渠道，凭证存在即启用）
 *   - "feishu"       → ["feishu"]
 *   - "feishu,wecom" → ["feishu", "wecom"]
 *   - 未知渠道名会记录警告并跳过
 */
function resolveEnabledChannels(client: PluginClient): ChannelName[] | null {
  const raw = process.env["CHAT_CHANNELS"]?.trim();

  // 未配置或空值 → 自动模式
  if (!raw) return null;

  const requested = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const known = Object.keys(CHANNEL_REGISTRY) as ChannelName[];
  const enabled: ChannelName[] = [];

  for (const name of requested) {
    if (known.includes(name as ChannelName)) {
      enabled.push(name as ChannelName);
    } else {
      void client.app.log({
        body: {
          service: "chat-channel",
          level: "warn",
          message: `[config] 未知渠道名 "${name}"，已忽略。可用渠道：${known.join(", ")}`,
        },
      });
    }
  }

  return enabled;
}

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

    let responseText: string | null = null;
    try {
      const sessionId = await sessionManager.getOrCreate(userId);

      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
          // model/agent 均不指定，使用 opencode 默认配置，与终端对话保持一致
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

  // 确定候选渠道列表
  const enabledNames = resolveEnabledChannels(client);
  const factories: Array<[ChannelName, ChannelFactory]> = enabledNames
    ? // 显式模式：只启用用户指定的渠道
      enabledNames.map((name) => [name, CHANNEL_REGISTRY[name]])
    : // 自动模式：尝试所有已注册渠道
      (Object.entries(CHANNEL_REGISTRY) as Array<[ChannelName, ChannelFactory]>);

  if (enabledNames) {
    await client.app.log({
      body: {
        service: "chat-channel",
        level: "info",
        message: `[config] CHAT_CHANNELS="${process.env["CHAT_CHANNELS"]}"，将启用: ${enabledNames.join(", ") || "（无）"}`,
      },
    });
  }

  // 初始化渠道实例
  const channels: ChatChannel[] = [];
  for (const [, factory] of factories) {
    const channel = await factory(client);
    if (channel) channels.push(channel);
  }

  if (channels.length === 0) {
    const hint = enabledNames
      ? `检查 CHAT_CHANNELS="${process.env["CHAT_CHANNELS"]}" 指定的渠道是否已配置凭证`
      : "请在 .env 中配置至少一个渠道的凭证，或设置 CHAT_CHANNELS=<渠道名> 明确指定";
    await client.app.log({
      body: {
        service: "chat-channel",
        level: "warn",
        message: `所有渠道均未就绪，插件空启动。${hint}`,
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

// 导出类型，供自定义渠道实现使用
// 注意：工具函数 (extractResponseText, loadDotEnv) 不在此导出，
// 以避免 opencode 插件加载器将其误当作 Plugin 函数执行。
// 如需使用这些工具函数，请直接从 "opencode-chat-channel/session-manager" 导入。
export type { ChatChannel, ChannelFactory, ChannelName, IncomingMessage, PluginClient } from "./types.js";
