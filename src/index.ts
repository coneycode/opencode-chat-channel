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
 * 过滤 Markdown 表格语法，避免飞书卡片 230099 错误（card table number over limit）。
 * 将表格行替换为占位文本，保留其他内容。
 */
function stripMarkdownTables(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      // 表格分隔行（|---|---| 或 | --- | --- |）
      if (/^\|[-:\s|]+\|$/.test(trimmed)) return "";
      // 表格数据行：以 | 开头（不管有没有结尾 |，截断行也算）
      if (trimmed.startsWith("|")) return "[表格内容]";
      return line;
    })
    // 去除连续多个 [表格内容] 重复行
    .filter((line, i, arr) => !(line === "[表格内容]" && arr[i - 1] === "[表格内容]"))
    .join("\n")
    .trim();
}

/** reasoning 摘要最大字符数 */
const REASONING_PREVIEW_LEN = 200;

/** patch 节流间隔（ms）：避免高频 reasoning 刷屏 */
const PATCH_THROTTLE_MS = 3000;

/**
 * 为指定渠道创建消息处理函数。
 * 每个渠道拥有独立的 SessionManager（用户 session 互不干扰）。
 *
 * 流程：
 *   1. 发送"正在思考"占位卡片（支持 patch 的渠道）
 *   2. promptAsync 发起 AI 请求（立即返回）
 *   3. 订阅 SSE 事件流，实时 patch 更新占位卡片
 *      - reasoning part → 更新为思考摘要
 *      - tool part (running) → 更新为"正在使用工具: xxx"
 *   4. session idle 时发送最终文字回复
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

    // ── 步骤 1: 发占位卡片 ──────────────────────────────────────────────────
    let thinkingMsgId: string | null = null;
    if (channel.sendThinkingCard) {
      thinkingMsgId = await channel.sendThinkingCard(replyTarget);
    }

    let sessionId: string;
    try {
      sessionId = await sessionManager.getOrCreate(userId);
    } catch (err: unknown) {
      const errorMsg = (err as any)?.message ?? String(err);
      await client.app.log({
        body: { service: "chat-channel", level: "error", message: `[${channel.name}] 获取 session 失败: ${errorMsg}`, extra: { userId } },
      });
      await channel.send(replyTarget, `⚠️ 出错了：${errorMsg}`);
      return;
    }

    // ── 步骤 2: 先建立 SSE 订阅，再发 prompt（避免 race condition） ──────────
    // 如果先 promptAsync 再订阅 SSE，AI 可能在 SSE 连接建立之前就完成了，
    // 导致 session.idle 事件被错过，消息永远不会发出去。
    let eventStream: Awaited<ReturnType<typeof client.event.subscribe>> | null = null;
    try {
      eventStream = await client.event.subscribe();
    } catch (err: unknown) {
      // SSE 订阅失败，降级：仍然发 prompt，最后用轮询获取结果
      await client.app.log({
        body: { service: "chat-channel", level: "warn", message: `[${channel.name}] SSE 订阅失败，降级为轮询: ${String(err)}` },
      });
    }

    // ── 步骤 3: promptAsync 发起请求（AI 在后台运行） ────────────────────────
    try {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
        },
      });
    } catch (err: unknown) {
      const errorMsg = (err as any)?.data?.message ?? (err as any)?.message ?? String(err);
      await client.app.log({
        body: { service: "chat-channel", level: "error", message: `[${channel.name}] promptAsync 失败: ${errorMsg}`, extra: { userId } },
      });
      // 更新占位卡片为错误状态
      if (thinkingMsgId && channel.updateThinkingCard) {
        await channel.updateThinkingCard(thinkingMsgId, `⚠️ 出错了：${errorMsg}`);
      } else {
        await channel.send(replyTarget, `⚠️ 出错了：${errorMsg}`);
      }
      return;
    }

    // ── 步骤 4: 消费 SSE 事件流，等待 session 完成，发送最终回复 ─────────────
    await consumeSessionEvents(client, channel, sessionId, replyTarget, thinkingMsgId, eventStream);
  };
}

/**
 * 订阅 opencode 全局 SSE 事件流，等待指定 session 完成。
 * 期间实时 patch 更新思考占位卡片，完成后发送最终回复。
 *
 * 注意：eventStream 必须在 promptAsync 之前建立（由调用方负责），
 * 以避免 race condition（AI 完成时 SSE 尚未建立，session.idle 被错过）。
 */
async function consumeSessionEvents(
  client: PluginClient,
  channel: ChatChannel,
  sessionId: string,
  replyTarget: string,
  thinkingMsgId: string | null,
  /** 已在 promptAsync 之前建立的 SSE 订阅；为 null 时降级为轮询 */
  eventStream: Awaited<ReturnType<typeof client.event.subscribe>> | null
): Promise<void> {
  // 节流控制：上次 patch 的时间戳
  let lastPatchAt = 0;
  // 累积的 reasoning 文本（用于摘要）
  let reasoningAccum = "";

  const log = (level: "info" | "warn" | "error", message: string) =>
    void client.app.log({ body: { service: "chat-channel", level, message } });

  /**
   * 节流 patch：距上次 patch 超过 PATCH_THROTTLE_MS 才实际发送。
   * 强制更新时忽略节流（用于最终状态）。
   */
  async function throttledPatch(text: string, force = false): Promise<void> {
    if (!thinkingMsgId || !channel.updateThinkingCard) return;
    const now = Date.now();
    if (!force && now - lastPatchAt < PATCH_THROTTLE_MS) return;
    lastPatchAt = now;
    await channel.updateThinkingCard(thinkingMsgId, text);
  }

  if (eventStream) {
    // 先检查 session 是否已经 idle（SSE 是 lazy generator，HTTP 连接
    // 在 for-await 时才建立，可能错过已经发布的 session.idle 事件）
    let alreadyDone = false;
    try {
      const statusRes = await client.session.status();
      const allStatuses = statusRes.data ?? {};
      const sessionStatus = (allStatuses as Record<string, { type: string }>)[sessionId];
      if (!sessionStatus || sessionStatus.type === "idle") {
        alreadyDone = true;
        log("info", `[${channel.name}] session 已完成，跳过 SSE 等待`);
      }
    } catch {
      // 查询失败时继续走 SSE 路径
    }

    if (!alreadyDone) {
      // SSE 等待，加超时保障（最多 3 分钟）
      const SSE_TIMEOUT_MS = 3 * 60 * 1000;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => {
        log("warn", `[${channel.name}] SSE 等待超时，强制结束`);
        abortController.abort();
      }, SSE_TIMEOUT_MS);

      try {
        for await (const event of eventStream.stream) {
          if (abortController.signal.aborted) break;
          if (!isSessionEvent(event, sessionId)) continue;

          if (event.type === "message.part.updated") {
            const part = event.properties?.part;
            if (!part) continue;

            if (part.type === "reasoning" && part.text) {
              reasoningAccum = part.text;
              const preview = stripMarkdownTables(reasoningAccum.slice(0, REASONING_PREVIEW_LEN));
              const suffix = reasoningAccum.length > REASONING_PREVIEW_LEN ? "..." : "";
              await throttledPatch(`💭 **正在思考...**\n\n${preview}${suffix}`);
            } else if (part.type === "tool" && part.state?.status === "running") {
              const toolLabel = (part.tool ?? "") || "工具";
              await throttledPatch(`🔧 **正在使用工具：${toolLabel}**`);
            }
          }

          if (event.type === "session.idle" || event.type === "session.error") {
            break;
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          log("warn", `[${channel.name}] SSE 事件流中断: ${String(err)}`);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }
  } else {
    // SSE 不可用时，轮询等待 session 完成
    await pollForSessionCompletion(client, channel.name, sessionId);
  }

  // 获取最终回复并发送
  let responseText: string | null = null;
  try {
    const messagesRes = await client.session.messages({ path: { id: sessionId } });
    const messages = messagesRes.data ?? [];
    const lastAssistant = [...messages].reverse().find((m: any) => m.info?.role === "assistant");
    if (lastAssistant) {
      responseText = extractResponseText(lastAssistant.parts ?? []);
    }
  } catch (err) {
    log("error", `[${channel.name}] 获取最终回复失败: ${String(err)}`);
  }

  if (!responseText) {
    responseText = "（AI 没有返回文字回复）";
  }

  // 发送最终文字回复（始终发新消息，占位卡片保持最后的思考状态）
  await channel.send(replyTarget, responseText);
}

/**
 * SSE 不可用时的降级方案：轮询等待 session 变为 idle 状态。
 * 每 1 秒查询一次，最多等待 5 分钟。
 */
async function pollForSessionCompletion(
  client: PluginClient,
  channelName: string,
  sessionId: string
): Promise<void> {
  const POLL_INTERVAL_MS = 1000;
  const MAX_WAIT_MS = 5 * 60 * 1000; // 5 分钟
  const started = Date.now();

  while (Date.now() - started < MAX_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    try {
      const res = await client.session.status();
      const allStatuses = res.data ?? {};
      const sessionStatus = (allStatuses as Record<string, { type: string }>)[sessionId];
      if (!sessionStatus || sessionStatus.type === "idle") break; // idle 或已删除
    } catch {
      // 查询失败时继续等待
      void client.app.log({
        body: { service: "chat-channel", level: "warn", message: `[${channelName}] 轮询 session 状态失败，继续等待...` },
      });
    }
}
}

/**
 * 判断一个 SSE 事件是否属于指定 session。
 * message.part.updated / session.idle / session.error 都带 sessionID。
 */
function isSessionEvent(event: any, sessionId: string): boolean {
  if (!event || !event.type) return false;
  const props = event.properties;
  if (!props) return false;

  // message.part.updated: properties.part.sessionID
  if (event.type === "message.part.updated") {
    return props.part?.sessionID === sessionId;
  }
  // session.idle / session.error: properties.sessionID
  return props.sessionID === sessionId || props.id === sessionId;
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
