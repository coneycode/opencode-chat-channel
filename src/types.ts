/**
 * opencode-chat-channel — 多渠道抽象层
 *
 * 每个渠道（飞书、企业微信等）实现 ChatChannel 接口即可接入。
 */

import type { Plugin } from "@opencode-ai/plugin";

/** opencode Plugin 客户端类型（从 Plugin 回调参数中提取） */
export type PluginClient = Parameters<Plugin>[0]["client"];

// ─── 渠道消息标准化模型 ─────────────────────────────────────────────────────

/** 从渠道收到的标准化消息 */
export interface IncomingMessage {
  /** 消息唯一 ID（用于去重） */
  messageId: string;
  /** 用户唯一标识（用于 session 绑定，不同渠道格式不同） */
  userId: string;
  /** 回复目标 ID（群 ID / 用户 ID，由渠道决定具体含义） */
  replyTarget: string;
  /** 消息文本内容 */
  text: string;
}

// ─── Channel 接口 ──────────────────────────────────────────────────────────

/**
 * ChatChannel — 渠道适配器接口
 *
 * 每个渠道实现此接口：
 *   - name: 渠道标识符（用于日志、配置 key）
 *   - start(): 启动监听，收到消息时调用 onMessage 回调
 *   - send(): 向指定 target 发送文本回复
 *   - stop(): 优雅关闭（可选）
 */
export interface ChatChannel {
  /** 渠道唯一名称，如 "feishu"、"wecom" */
  readonly name: string;

  /**
   * 启动渠道监听。
   * 每当收到用户消息时，调用 onMessage(msg)。
   */
  start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void>;

  /**
   * 向指定目标发送文本消息。
   * replyTarget 为 IncomingMessage.replyTarget。
   */
  send(replyTarget: string, text: string): Promise<void>;

  /** 优雅停止渠道（可选）。 */
  stop?(): Promise<void>;
}

// ─── 渠道工厂函数类型 ──────────────────────────────────────────────────────

/**
 * ChannelFactory — 渠道工厂函数签名
 *
 * 工厂函数负责读取配置、验证凭证、构造并返回 ChatChannel 实例。
 * 若凭证未配置，应返回 null（插件将跳过该渠道并记录日志）。
 */
export type ChannelFactory = (
  client: PluginClient
) => Promise<ChatChannel | null>;

// ─── 已知渠道名称 ──────────────────────────────────────────────────────────────────

/**
 * 已注册的渠道名称。
 * 新增渠道时在此处添加对应字面量，便于编译期检查。
 */
export type ChannelName = "feishu" | "wecom";
