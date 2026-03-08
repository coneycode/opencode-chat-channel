/**
 * opencode-chat-channel — SessionManager
 *
 * 管理"渠道用户 ID → opencode session"的映射。
 * 与具体渠道无关，所有 channel 实现共享同一套逻辑。
 */

import { readFileSync, appendFileSync, mkdirSync } from "fs";
import type { PluginClient } from "./types.js";

// ─── 文件日志 ────────────────────────────────────────────────────────────────

const LOG_DIR = `${process.env["HOME"] ?? "/tmp"}/.local/share/opencode/log`;
const LOG_FILE = `${LOG_DIR}/chat-channel.log`;

/**
 * 写日志到文件（同步追加），同时调用 client.app.log()。
 * 用于替代纯依赖 client.app.log() 的场景，确保日志落盘可查。
 */
export function fileLog(level: "info" | "warn" | "error", message: string): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    appendFileSync(LOG_FILE, `${ts} [${level.toUpperCase()}] ${message}\n`, "utf8");
  } catch {
    // 写文件失败时静默忽略，不影响主流程
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

// ─── SessionManager ───────────────────────────────────────────────────────────

export class SessionManager {
  /**
   * @param client   opencode plugin 客户端（用于创建 session 和日志）
   * @param channel  渠道名称（用于日志标识）
   * @param titleFn  生成 session 标题的函数（可选，默认使用 userId）
   */
  constructor(
    private readonly client: PluginClient,
    private readonly channel: string,
    private readonly titleFn: (userId: string) => string = (id) =>
      `${channel} · ${id}`
  ) {}

  private readonly sessions = new Map<string, SessionMeta>();

  /** 获取已有的有效 session，或为该用户创建新 session。 */
  async getOrCreate(userId: string): Promise<string> {
    const existing = this.sessions.get(userId);
    const now = Date.now();

    if (existing && now - existing.lastActivity < SESSION_TTL_MS) {
      existing.lastActivity = now;
      return existing.sessionId;
    }

    // 创建新 session
    const res = await this.client.session.create({
      body: { title: this.titleFn(userId) },
    });

    const sessionId = res.data!.id;
    this.sessions.set(userId, { sessionId, lastActivity: now });

    await this.client.app.log({
      body: {
        service: "chat-channel",
        level: "info",
        message: `[${this.channel}] 创建新 session: ${sessionId}`,
        extra: { userId },
      },
    });

    return sessionId;
  }

  /** 清理所有已过期的 session 记录。 */
  cleanup(): void {
    const now = Date.now();
    for (const [userId, meta] of this.sessions.entries()) {
      if (now - meta.lastActivity > SESSION_TTL_MS) {
        this.sessions.delete(userId);
      }
    }
  }

  /** 启动定时清理（默认每 30 分钟）。返回 timer，供外部 clearInterval。 */
  startAutoCleanup(intervalMs = 30 * 60 * 1000): ReturnType<typeof setInterval> {
    return setInterval(() => this.cleanup(), intervalMs);
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 从 AI 响应 parts 中提取纯文本。
 * 与渠道无关，各 channel 实现均可复用。
 */
export function extractResponseText(parts: unknown[]): string {
  if (!Array.isArray(parts)) return "";
  return (parts as Array<{ type?: string; text?: string }>)
    .filter((p) => p?.type === "text")
    .map((p) => p?.text ?? "")
    .join("")
    .trim();
}

/**
 * 从 ~/.config/opencode/.env 读取环境变量并注入 process.env。
 * opencode 不会自动加载该文件，需插件自行调用。
 */
export function loadDotEnv(envPath: string): void {
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env 文件不存在或不可读，忽略
  }
}
