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
import { loadDotEnv, SessionManager, extractResponseText, fileLog } from "./session-manager.js";
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

/**
 * 待处理的 session 完成等待 Map。
 * key = sessionId，value = PendingEntry 包含 resolve/reject 及实时 patch 所需状态。
 * 由 ChatChannelPlugin 创建后注入到 createMessageHandler 中使用。
 */
type PendingEntry = {
  resolve: () => void;
  reject: (err: Error) => void;
  /** sendThinkingCard 返回的 message_id，用于 patch 更新 */
  thinkingMsgId: string | null;
  /** 对应的渠道实例，用于调用 patchProgress / patchDone */
  channel: ChatChannel;
  /** 回复目标（chat_id），用于发送最终回复 */
  replyTarget: string;
  /** 最后一次执行 patch 的时间戳（ms），用于节流 */
  lastPatchTime: number;
  /** 节流延迟 patch 的 timer，存在则说明有待执行的 patch */
  pendingPatchTimer: ReturnType<typeof setTimeout> | null;
  /** 当前累积的 reasoning 全文（opencode 每次发全量，直接覆盖） */
  reasoning: string;
  /**
   * 按 part id 追踪的 text 片段（有序，支持多 step 累积）。
   * opencode 对同一 part 发全量更新（非 delta），直接按 id 覆盖对应槽位。
   * 不同 step 产生的 text 拥有不同 part id，因此可以并排保留。
   */
  textParts: Map<string, string>;
  /** text part id 的有序数组，保证拼接顺序与 AI 输出顺序一致 */
  textPartOrder: string[];
  /**
   * 按 callID 追踪的工具调用状态（pending / running / completed）。
   * 同一 callID 的 part 会多次更新，直接覆盖。
   */
  toolParts: Map<string, { tool: string; status: string; input?: unknown; output?: string }>;
  /** tool callID 的有序数组，保证展示顺序与 AI 调用顺序一致 */
  toolPartOrder: string[];
};
type PendingMap = Map<string, PendingEntry>;

/** patch 节流间隔（ms）：避免高频 reasoning 触发飞书限频（5 QPS） */
const PATCH_THROTTLE_MS = 2000;

/** 从 entry 状态构建折叠面板内部的 detail 文本（Markdown） */
function buildDetailContent(entry: PendingEntry): string {
  const parts: string[] = [];
  if (entry.reasoning) {
    parts.push(`**💭 推理过程**\n${entry.reasoning}`);
  }
  // 工具调用行（简洁格式：图标 + 名称 + 状态）
  for (const callId of entry.toolPartOrder) {
    const t = entry.toolParts.get(callId);
    if (!t) continue;
    const statusIcon = t.status === "completed" ? "✓" : t.status === "running" ? "..." : "⏳";
    const inputStr = t.input !== undefined ? `\n  input: \`${JSON.stringify(t.input)}\`` : "";
    const outputStr = t.output ? `\n  output: ${t.output.length > 200 ? t.output.slice(0, 200) + "..." : t.output}` : "";
    parts.push(`🔧 **${t.tool}** (${statusIcon})${inputStr}${outputStr}`);
  }
  // 文本内容（多 step 累积，追加不覆盖）
  const allText = entry.textPartOrder
    .map((id) => entry.textParts.get(id) ?? "")
    .filter(Boolean)
    .join("\n\n");
  if (allText) {
    parts.push(`**✍️ 回复内容**\n${allText}`);
  }
  return parts.join("\n\n---\n\n") || "（暂无内容）";
}

/** 执行一次 patch，更新卡片内容，并重置节流计时 */
function doPatch(entry: PendingEntry): void {
  if (!entry.thinkingMsgId) return;
  entry.lastPatchTime = Date.now();
  const hasText = entry.textPartOrder.some((id) => (entry.textParts.get(id) ?? "").length > 0);
  const stage = hasText ? "replying" : "reasoning";
  const summaryText = hasText ? "✍️ 正在输出回复..." : "🤔 正在推理...";
  const detail = buildDetailContent(entry);
  // 异步 patch，失败静默忽略（channel.patchProgress 内部已处理）
  void entry.channel.patchProgress?.(entry.thinkingMsgId, summaryText, detail, stage);
}

/** 节流调度：距上次 patch 超过阈值则立即执行，否则等到下个窗口 */
function scheduleThrottledPatch(entry: PendingEntry): void {
  const now = Date.now();
  if (now - entry.lastPatchTime >= PATCH_THROTTLE_MS) {
    doPatch(entry);
  } else if (!entry.pendingPatchTimer) {
    const delay = PATCH_THROTTLE_MS - (now - entry.lastPatchTime);
    entry.pendingPatchTimer = setTimeout(() => {
      entry.pendingPatchTimer = null;
      doPatch(entry);
    }, delay);
  }
}

/**
 * 为指定渠道创建消息处理函数。
 * 每个渠道拥有独立的 SessionManager（用户 session 互不干扰）。
 *
 * 流程：
 *   1. 发送"正在思考"占位卡片（支持 patch 的渠道）
 *   2. promptAsync 发起 AI 请求（立即返回）
 *   3. 等待 event 钩子回调（session.idle / session.error），由 pendingMap 协调
 *      - 期间 message.part.updated 事件触发节流 patch，实时更新卡片内容
 *   4. session 完成后 patch 卡片为完成态，读取最终回复并发送
 */
function createMessageHandler(
  channel: ChatChannel,
  sessionManager: SessionManager,
  client: PluginClient,
  pendingMap: PendingMap
) {
  return async (msg: IncomingMessage): Promise<void> => {
    const { userId, replyTarget, text } = msg;

    const incomingMsg = `[${channel.name}] 收到消息: "${text.slice(0, 80)}${text.length > 80 ? "..." : ""}"`;
    fileLog("info", incomingMsg);
    await client.app.log({
      body: {
        service: "chat-channel",
        level: "info",
        message: incomingMsg,
        extra: { userId, replyTarget },
      },
    });

    // ── 步骤 1: 发占位卡片 ──────────────────────────────────────────────────
    let thinkingMsgId: string | null = null;
    if (channel.sendThinkingCard) {
      thinkingMsgId = await channel.sendThinkingCard(replyTarget);
      fileLog("info", `[${channel.name}] sendThinkingCard 完成: thinkingMsgId=${thinkingMsgId}`);
    }

    let sessionId: string;
    try {
      sessionId = await sessionManager.getOrCreate(userId);
    } catch (err: unknown) {
      const errorMsg = (err as any)?.message ?? String(err);
      const errMsg1 = `[${channel.name}] 获取 session 失败: ${errorMsg}`;
      fileLog("error", errMsg1);
      await client.app.log({
        body: { service: "chat-channel", level: "error", message: errMsg1, extra: { userId } },
      });
      await channel.send(replyTarget, `⚠️ 出错了：${errorMsg}`);
      return;
    }

    // ── 步骤 2: promptAsync 发起请求（AI 在后台运行） ────────────────────────
    try {
      await client.session.promptAsync({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text }],
        },
      });
      fileLog("info", `[${channel.name}] promptAsync 成功: sessionId=${sessionId}`);
    } catch (err: unknown) {
      const errorMsg = (err as any)?.data?.message ?? (err as any)?.message ?? String(err);
      fileLog("error", `[${channel.name}] promptAsync 失败: ${errorMsg}`);
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

    // ── 步骤 3: 等待 session 完成（由 event 钩子触发），发送最终回复 ───────────
    await waitForSessionAndReply(client, channel, sessionId, replyTarget, thinkingMsgId, pendingMap);
  };
}

/**
 * 向 pendingMap 注册一个 Promise，等待 event 钩子的 session.idle / session.error 触发。
 * 触发后读取最终回复并发送到渠道。
 *
 * 利用 opencode 插件的 event 钩子（进程内函数回调），完全绕开 SSE 的
 * AsyncLocalStorage context 隔离问题。
 */
async function waitForSessionAndReply(
  client: PluginClient,
  channel: ChatChannel,
  sessionId: string,
  replyTarget: string,
  thinkingMsgId: string | null,
  pendingMap: PendingMap
): Promise<void> {
  const log = (level: "info" | "warn" | "error", message: string) => {
    fileLog(level, message);
    void client.app.log({ body: { service: "chat-channel", level, message } });
  };

  // 注册 Promise，等待 event 钩子 resolve
  const SESSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟兜底超时
  await new Promise<void>((resolve, reject) => {
    // 兜底超时，防止 event 钩子因某种原因永远不来
    const timeoutId = setTimeout(() => {
      pendingMap.delete(sessionId);
      log("warn", `[${channel.name}] session 等待超时（5分钟），强制继续读取回复`);
      resolve(); // 超时也继续读消息，不 reject
    }, SESSION_TIMEOUT_MS);

    pendingMap.set(sessionId, {
      resolve: () => {
        clearTimeout(timeoutId);
        pendingMap.delete(sessionId);
        resolve();
      },
      reject: (err: Error) => {
        clearTimeout(timeoutId);
        pendingMap.delete(sessionId);
        reject(err);
      },
      thinkingMsgId,
      channel,
      replyTarget,
      lastPatchTime: 0,
      pendingPatchTimer: null,
      reasoning: "",
      textParts: new Map(),
      textPartOrder: [],
      toolParts: new Map(),
      toolPartOrder: [],
    });
  }).catch((err: Error) => {
    log("error", `[${channel.name}] session 出错: ${err.message}`);
  });

  // 卡片已在 event 钩子（session.idle）中 patchDone 更新为完成态，
  // 不再额外发送文本回复，避免内容重复。
  log("info", `[${channel.name}] session 完成，卡片已更新，跳过文本回复`);
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

  // 跨渠道共享的 pendingMap：sessionId → PendingEntry
  // event 钩子（进程内回调）通过此 Map 唤醒等待中的消息处理协程
  const pendingMap: PendingMap = new Map();

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

    const handleMessage = createMessageHandler(channel, sessionManager, client, pendingMap);
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
      const props = event.properties as Record<string, unknown> | undefined;

      // ── message.part.updated：AI 正在输出，触发节流 patch ──────────────────
      if (event.type === "message.part.updated") {
        const part = props?.["part"] as Record<string, unknown> | undefined;
        // 诊断日志：记录 part 实际结构，供调试字段名使用
        fileLog("info", `[diag] part.updated raw: ${JSON.stringify(part).slice(0, 300)}`);
        const sessionId = (part?.["sessionID"] ?? part?.["session_id"]) as string | undefined;
        if (sessionId) {
          const entry = pendingMap.get(sessionId);
          if (entry) {
            const partType = part?.["type"] as string | undefined;
            const partId = part?.["id"] as string | undefined;
            if (partType === "reasoning") {
              entry.reasoning = (part?.["text"] ?? "") as string;
              scheduleThrottledPatch(entry);
            } else if (partType === "text") {
              if (partId) {
                if (!entry.textParts.has(partId)) {
                  entry.textPartOrder.push(partId);
                }
                entry.textParts.set(partId, (part?.["text"] ?? "") as string);
              }
              scheduleThrottledPatch(entry);
            } else if (partType === "tool") {
              const callId = part?.["callID"] as string | undefined;
              const toolName = part?.["tool"] as string | undefined;
              const toolState = part?.["state"] as Record<string, unknown> | undefined;
              const status = toolState?.["status"] as string | undefined;
              const toolInput = toolState?.["input"];
              const toolOutput = toolState?.["output"] as string | undefined;
              if (callId && toolName && status) {
                if (!entry.toolParts.has(callId)) {
                  entry.toolPartOrder.push(callId);
                }
                entry.toolParts.set(callId, { tool: toolName, status, input: toolInput, output: toolOutput });
                // tool 更新也触发节流 patch，让工具进展可见
                scheduleThrottledPatch(entry);
              }
              // step-start / step-finish: 无需处理
            }
          }
        }
      }

      if (event.type === "session.idle") {
        const sessionId = (props?.["sessionID"] ?? props?.["id"]) as string | undefined;
        if (sessionId) {
          fileLog("info", `[diag] event hook: session.idle sessionId=${sessionId}`);
          const entry = pendingMap.get(sessionId);
          if (entry) {
            // 取消尚未执行的节流 patch
            if (entry.pendingPatchTimer) {
              clearTimeout(entry.pendingPatchTimer);
              entry.pendingPatchTimer = null;
            }
            // patch 卡片为完成态
            fileLog("info", `[diag] session.idle: thinkingMsgId=${entry.thinkingMsgId}, hasPatchDone=${!!entry.channel.patchDone}, reasoning.len=${entry.reasoning.length}, textParts.count=${entry.textPartOrder.length}, toolParts.count=${entry.toolPartOrder.length}`);
            if (entry.thinkingMsgId && entry.channel.patchDone) {
              const detail = buildDetailContent(entry);
              await entry.channel.patchDone(entry.thinkingMsgId, detail);
            }
            entry.resolve();
          }
        }
      }

      if (event.type === "session.error") {
        const sessionId = (props?.["sessionID"] ?? props?.["id"]) as string | undefined;
        const errMsg = (props?.["message"] ?? "unknown error") as string;
        await client.app.log({
          body: {
            service: "chat-channel",
            level: "warn",
            message: "opencode session 出现错误",
            extra: props as Record<string, unknown>,
          },
        });
        if (sessionId) {
          fileLog("info", `[diag] event hook: session.error sessionId=${sessionId} err=${errMsg}`);
          const entry = pendingMap.get(sessionId);
          if (entry) {
            // 取消尚未执行的节流 patch
            if (entry.pendingPatchTimer) {
              clearTimeout(entry.pendingPatchTimer);
              entry.pendingPatchTimer = null;
            }
            entry.reject(new Error(errMsg));
          }
        }
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
