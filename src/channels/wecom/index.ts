/**
 * opencode-chat-channel — 企业微信渠道适配器（骨架）
 *
 * 企业微信接入方式：
 *   - 自建应用通过"企业微信回调"（HTTP Webhook）接收消息
 *   - 或通过"接收消息" API（需要公网地址或内网穿透）
 *
 * 凭证配置（待实现时填充）：
 *   WECOM_CORP_ID      企业 ID，存放在 ~/.config/opencode/.env
 *   WECOM_AGENT_ID     应用 AgentId，存放在 ~/.config/opencode/.env
 *   WECOM_SECRET       应用 Secret，存 macOS Keychain：
 *     security add-generic-password -a chat-channel-wecom -s opencode-chat-channel -w <secret> -U
 *   WECOM_TOKEN        企业微信回调 Token，存放在 ~/.config/opencode/.env
 *   WECOM_ENCODING_AES_KEY  企业微信消息加解密 Key，存 macOS Keychain：
 *     security add-generic-password -a chat-channel-wecom-aes -s opencode-chat-channel -w <key> -U
 *
 * TODO: 完整实现
 *   1. 启动 HTTP 服务器接收企业微信回调（验证 Token、解密消息体）
 *   2. 调用企业微信 API 发送文本消息
 *   3. 支持消息加解密（EnterpriseWeChatCrypto）
 *
 * 参考文档：
 *   https://developer.work.weixin.qq.com/document/path/90238
 *   https://developer.work.weixin.qq.com/document/path/90236
 */

import type { ChatChannel, ChannelFactory, IncomingMessage, PluginClient } from "../../types.js";

// ─── WeComChannel 骨架实现 ────────────────────────────────────────────────────

class WeComChannel implements ChatChannel {
  readonly name = "wecom";

  constructor(
    private readonly corpId: string,
    private readonly agentId: string,
    private readonly secret: string,
    private readonly client: PluginClient
  ) {}

  /**
   * 启动企业微信消息监听。
   *
   * 企业微信推送消息到指定回调 URL（HTTP），本方法应：
   * 1. 启动一个 HTTP 服务器监听回调请求
   * 2. 验证消息签名（Token + Timestamp + Nonce）
   * 3. 解密消息体（AES 加密）
   * 4. 解析消息类型，仅处理文本消息
   * 5. 调用 onMessage 回调
   *
   * @todo 待实现
   */
  async start(onMessage: (msg: IncomingMessage) => Promise<void>): Promise<void> {
    await this.client.app.log({
      body: {
        service: "chat-channel",
        level: "warn",
        message: "[wecom] 企业微信渠道尚未实现，已跳过。如需接入，请参考 src/channels/wecom/index.ts 中的 TODO。",
      },
    });

    // TODO: 实现 HTTP 回调服务器
    // 示例结构（非完整代码）：
    //
    // import { createServer } from "http";
    // import { WeComCrypto } from "some-wecom-sdk";
    //
    // const server = createServer(async (req, res) => {
    //   // 1. 验证签名：signature = sha1(sort([token, timestamp, nonce]).join(""))
    //   // 2. GET 请求为验证回调（返回 echostr）
    //   // 3. POST 请求为消息推送（解密 → 解析 XML → 调用 onMessage）
    //   res.end("success");
    // });
    // server.listen(WECOM_PORT);
    void onMessage; // 消除 unused 警告，实现后删除此行
  }

  /**
   * 向企业微信用户或群发送文本消息。
   *
   * 调用企业微信"发送应用消息" API：
   *   POST https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=...
   *
   * @todo 待实现
   */
  async send(replyTarget: string, text: string): Promise<void> {
    // TODO: 实现企业微信消息发送
    // 示例（非完整代码）：
    //
    // const token = await this.getAccessToken();
    // await fetch(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    //   method: "POST",
    //   body: JSON.stringify({
    //     touser: replyTarget,
    //     msgtype: "text",
    //     agentid: this.agentId,
    //     text: { content: text },
    //   }),
    // });
    void replyTarget;
    void text;
    throw new Error("[wecom] WeComChannel.send() 尚未实现");
  }

  // ── 内部工具（待实现） ────────────────────────────────────────────────────

  /**
   * 获取企业微信 access_token（带缓存，避免频繁请求）。
   * @todo 待实现
   */
  // private async getAccessToken(): Promise<string> {
  //   // GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=...&corpsecret=...
  //   throw new Error("Not implemented");
  // }
}

// ─── 工厂函数 ─────────────────────────────────────────────────────────────────

/**
 * 企业微信渠道工厂函数。
 *
 * 读取 WECOM_CORP_ID / WECOM_AGENT_ID 环境变量，
 * 以及 Keychain 中的 WECOM_SECRET。
 * 任意凭证缺失时返回 null，插件跳过该渠道。
 *
 * @todo 待企业微信实现完成后启用此工厂函数
 */
export const wecomChannelFactory: ChannelFactory = async (client: PluginClient) => {
  const corpId = process.env["WECOM_CORP_ID"];
  const agentId = process.env["WECOM_AGENT_ID"];

  // TODO: 从 Keychain 读取 WECOM_SECRET
  // const secret = readWecomSecretFromKeychain();
  const secret: string | undefined = undefined;

  if (!corpId || !agentId || !secret) {
    // 仅在至少配置了 WECOM_CORP_ID 时才发出警告（避免默认安装时刷屏）
    if (corpId || agentId) {
      await client.app.log({
        body: {
          service: "chat-channel",
          level: "warn",
          message: "[wecom] 企业微信凭证不完整（需要 WECOM_CORP_ID、WECOM_AGENT_ID、WECOM_SECRET），渠道已跳过",
        },
      });
    }
    return null;
  }

  return new WeComChannel(corpId, agentId, secret, client);
};
