/**
 * opencode-feishu-bot — opencode 飞书机器人插件
 *
 * 通过飞书长连接（WebSocket）接收消息，驱动 opencode AI 回复。
 *
 * 凭证存储方案（macOS Keychain）：
 *   FEISHU_APP_ID 存放在 ~/.config/opencode/.env（非敏感，可见）
 *   FEISHU_APP_SECRET 存放在系统钥匙串，service=opencode-feishu-bot，account=feishu-bot
 *   写入命令：
 *     security add-generic-password -a feishu-bot -s opencode-feishu-bot -w <secret> -U
 *
 * 每个飞书用户（open_id）独享一个 opencode session，对话历史保留。
 */

import type { Plugin } from "@opencode-ai/plugin";
import * as Lark from "@larksuiteoapi/node-sdk";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

// ─── 读取 .env 文件 ───────────────────────────────────────────────────────────

/**
 * 从指定路径读取 .env 文件，将其中的 KEY=VALUE 注入到 process.env。
 * opencode 启动时不会自动加载 ~/.config/opencode/.env，需要插件自行处理。
 */
function loadDotEnv(envPath: string): void {
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      // 不覆盖已有的环境变量（优先使用外部注入的）
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env 文件不存在或不可读，忽略
  }
}

// ─── 类型 ─────────────────────────────────────────────────────────────────────

interface SessionMeta {
  sessionId: string;
  lastActivity: number;
}

// ─── 常量 ─────────────────────────────────────────────────────────────────────

/** session 闲置超过此时间（ms）后自动清理，下次对话从新 session 开始 */
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时

// ─── 插件主体 ─────────────────────────────────────────────────────────────────

export const FeishuBotPlugin: Plugin = async ({ client }) => {
  // 先加载 .env 文件（opencode 不会自动注入，需插件自行读取）
  const configDir = join(
    process.env["HOME"] ?? "/Users/" + (process.env["USER"] ?? ""),
    ".config", "opencode"
  );
  loadDotEnv(join(configDir, ".env"));

  const appId = process.env["FEISHU_APP_ID"];

  // 从 macOS Keychain 读取 App Secret（不落盘明文）
  let appSecret: string | undefined;
  try {
    const stdout = execFileSync("security", [
      "find-generic-password",
      "-a", "feishu-bot",
      "-s", "opencode-feishu-bot",
      "-w",
    ], { encoding: "utf8" });
    appSecret = stdout.trim() || undefined;
  } catch {
    appSecret = undefined;
  }

  if (!appId || !appSecret) {
    await client.app.log({
      body: {
        service: "feishu-bot",
        level: "warn",
        message: !appId
          ? "FEISHU_APP_ID 未设置（请在 .env 中添加），飞书机器人插件已跳过"
          : "FEISHU_APP_SECRET 未找到（请写入 Keychain），飞书机器人插件已跳过",
      },
    });
    return {};
  }

  // 飞书 API 客户端（用于发送消息）
  const larkClient = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: Lark.Domain.Feishu,
  });

  // 用户 session 映射：feishu open_id → opencode session
  const userSessions = new Map<string, SessionMeta>();

  // ── 获取或创建 opencode session ──────────────────────────────────────────

  async function getOrCreateSession(openId: string): Promise<string> {
    const existing = userSessions.get(openId);
    const now = Date.now();

    if (existing && now - existing.lastActivity < SESSION_TTL_MS) {
      existing.lastActivity = now;
      return existing.sessionId;
    }

    // 创建新 session
    const res = await client.session.create({
      body: { title: `飞书对话 · ${openId}` },
    });

    const sessionId = res.data!.id;
    userSessions.set(openId, { sessionId, lastActivity: now });

    await client.app.log({
      body: {
        service: "feishu-bot",
        level: "info",
        message: `创建新 session: ${sessionId}`,
        extra: { openId },
      },
    });

    return sessionId;
  }

  // ── 清理过期 session ──────────────────────────────────────────────────────

  function cleanupExpiredSessions() {
    const now = Date.now();
    for (const [openId, meta] of userSessions.entries()) {
      if (now - meta.lastActivity > SESSION_TTL_MS) {
        userSessions.delete(openId);
      }
    }
  }
  setInterval(cleanupExpiredSessions, 30 * 60 * 1000);

  // ── 发送飞书文本消息 ──────────────────────────────────────────────────────

  async function replyToFeishu(chatId: string, text: string): Promise<void> {
    // 飞书消息长度限制 4096 字符，超长时分段发送
    const MAX_LEN = 4000;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += MAX_LEN) {
      chunks.push(text.slice(i, i + MAX_LEN));
    }

    for (const chunk of chunks) {
      await larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text: chunk }),
          msg_type: "text",
        },
      });
    }
  }

  // ── 发送"正在思考"占位消息 ──────────────────────────────────────────────

  async function sendThinking(chatId: string): Promise<void> {
    await larkClient.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text: "⏳ 正在思考..." }),
        msg_type: "text",
      },
    });
  }

  // ── 提取 AI 响应文本 ──────────────────────────────────────────────────────

  function extractResponseText(parts: unknown[]): string {
    if (!Array.isArray(parts)) return "";
    return parts
      .filter((p: any) => p?.type === "text")
      .map((p: any) => p?.text ?? "")
      .join("")
      .trim();
  }

  // ── 处理飞书消息 ──────────────────────────────────────────────────────────

  async function handleMessage(data: any): Promise<void> {
    const { message, sender } = data;

    // 只处理文本消息
    if (message.message_type !== "text") {
      await larkClient.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: message.chat_id,
          content: JSON.stringify({ text: "暂时只支持文本消息 😊" }),
          msg_type: "text",
        },
      });
      return;
    }

    // 解析消息内容
    let userText: string;
    try {
      userText = (JSON.parse(message.content) as { text: string }).text?.trim();
    } catch {
      return;
    }
    if (!userText) return;

    const openId = sender.sender_id?.open_id ?? message.chat_id;
    const chatId = message.chat_id;

    await client.app.log({
      body: {
        service: "feishu-bot",
        level: "info",
        message: `收到消息: "${userText.slice(0, 80)}${userText.length > 80 ? "..." : ""}"`,
        extra: { openId, chatId },
      },
    });

    // 先发"正在思考"
    await sendThinking(chatId);

    try {
      const sessionId = await getOrCreateSession(openId);

      // 发送给 opencode，等待 AI 完整回复
      const result = await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text: userText }],
        },
      });

      const responseText = extractResponseText(result.data?.parts ?? []);

      if (responseText) {
        await replyToFeishu(chatId, responseText);
      } else {
        await replyToFeishu(chatId, "（AI 没有返回文字回复）");
      }
    } catch (err: any) {
      const errorMsg = err?.message ?? String(err);
      await client.app.log({
        body: {
          service: "feishu-bot",
          level: "error",
          message: `处理消息失败: ${errorMsg}`,
          extra: { openId },
        },
      });
      await replyToFeishu(chatId, `⚠️ 出错了：${errorMsg}`);
    }
  }

  // ── 启动飞书 WSClient 长连接 ──────────────────────────────────────────────

  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel: Lark.LoggerLevel.warn,
  });

  wsClient.start({
    eventDispatcher: new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": handleMessage,
    }),
  });

  await client.app.log({
    body: {
      service: "feishu-bot",
      level: "info",
      message: `飞书机器人已启动（长连接模式），appId=${appId.slice(0, 8)}***`,
    },
  });

  // ── 插件钩子 ─────────────────────────────────────────────────────────────

  return {
    // 监听 opencode session 状态，用于调试
    event: async ({ event }: { event: { type: string; properties?: unknown } }) => {
      if (event.type === "session.error") {
        await client.app.log({
          body: {
            service: "feishu-bot",
            level: "warn",
            message: "opencode session 出现错误",
            extra: event.properties as Record<string, unknown>,
          },
        });
      }
    },
  };
};

export default FeishuBotPlugin;
