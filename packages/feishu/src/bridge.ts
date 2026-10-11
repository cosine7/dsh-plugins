import { randomUUID } from "node:crypto";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { Store } from "./store.js";
import { renderCard, deadline, choices } from "./cards.js";
import {
  identifier,
  text,
  type Channel,
  type Card,
  type IncomingAction,
  type IncomingMessage,
  type Host,
  type MaintenanceAgent,
} from "./types.js";

export class Bridge<A extends MaintenanceAgent> {
  private stopped = false;
  private scheduled = false;
  private pumping = new Map<string, Promise<void>>();
  private waiters = new Set<A>();
  private retry?: NodeJS.Timeout;
  private expiry?: NodeJS.Timeout;
  private signalStop!: () => void;
  private readonly stopSignal = new Promise<void>((resolve) => {
    this.signalStop = resolve;
  });
  onCardsChanged: () => void = () => {};

  constructor(
    readonly store: Store,
    readonly host: Host<A>,
    readonly now = () => Date.now(),
  ) {}

  channel(id: string): Channel {
    const channel = this.store.data.channels.find((c) => c.id === id);
    if (!channel) throw new Error("通道不存在，请先查看 feishu_status。");
    return channel;
  }
  card(id: string): Card {
    const card = this.store.data.cards.find((c) => c.id === id);
    if (!card) throw new Error("卡片不存在。");
    return card;
  }
  checkRevision(channel: Channel, revision: unknown) {
    if (!Number.isInteger(revision) || revision !== channel.revision)
      throw new Error("订阅已变化，请先查看最新 revision。");
  }
  requireOwner(id: string, sessionId: string): Channel {
    const channel = this.channel(id);
    if (!channel.enabled || channel.session_id !== sessionId)
      throw new Error("只有已启用通道的当前订阅 Session 可以发送或更新消息。");
    return channel;
  }

  configure(input: {
    id?: string;
    revision?: unknown;
    label: string;
    appIdRef: string;
    appSecretRef: string;
    openId: string;
  }): Channel {
    credentialRef(input.appIdRef);
    credentialRef(input.appSecretRef);
    identifier(input.openId, "ou_");
    text(input.label, "通道名称", 100);
    const id = input.id ?? randomUUID();
    if (this.store.data.channels.some((c) => c.id !== id && c.app_id_ref === input.appIdRef))
      throw new Error("同一应用凭据已有通道，请更新或转交现有通道。");
    this.store.transaction((data) => {
      const existing = data.channels.find((c) => c.id === id);
      if (existing) {
        this.checkRevision(existing, input.revision);
        if (existing.authorized_open_id !== input.openId && existing.session_id)
          throw new Error("更换授权用户前请先取消订阅。");
        if (existing.authorized_open_id !== input.openId) delete existing.chat_id;
        Object.assign(existing, {
          label: input.label,
          app_id_ref: input.appIdRef,
          app_secret_ref: input.appSecretRef,
          authorized_open_id: input.openId,
          enabled: true,
          revision: existing.revision + 1,
        });
      } else
        data.channels.push({
          id,
          label: input.label,
          app_id_ref: input.appIdRef,
          app_secret_ref: input.appSecretRef,
          authorized_open_id: input.openId,
          enabled: true,
          revision: 1,
        });
    });
    return structuredClone(this.channel(id));
  }

  subscribe(id: string, sessionId: string, revision: unknown, transfer = false): Channel {
    const channel = this.channel(id);
    this.checkRevision(channel, revision);
    if (!this.host.get(sessionId)) throw new Error("目标必须是已加载的活动根 Session。");
    if (channel.session_id && channel.session_id !== sessionId && !transfer)
      throw new Error("通道已有订阅者，请明确调用 feishu_transfer 转交。");
    this.store.transaction(() => {
      channel.session_id = sessionId;
      channel.revision++;
    });
    this.kick();
    return structuredClone(this.channel(id));
  }
  unsubscribe(id: string, revision: unknown): Channel {
    const channel = this.channel(id);
    this.checkRevision(channel, revision);
    this.store.transaction((data) => {
      delete channel.session_id;
      channel.revision++;
      for (const event of data.events)
        if (event.channel_id === id && event.state === "pending") event.state = "unassigned";
    });
    return structuredClone(this.channel(id));
  }
  stopSession(sessionId: string) {
    for (const channel of this.store.data.channels) {
      if (channel.session_id === sessionId) this.unsubscribe(channel.id, channel.revision);
    }
  }
  enable(id: string, revision: unknown, enabled: boolean): Channel {
    const channel = this.channel(id);
    this.checkRevision(channel, revision);
    this.store.transaction(() => {
      channel.enabled = enabled;
      channel.revision++;
    });
    if (enabled) this.kick();
    return structuredClone(this.channel(id));
  }

  receiveMessage(channelId: string, message: IncomingMessage): boolean {
    const channel = this.channel(channelId);
    if (
      !channel.enabled ||
      message.openId !== channel.authorized_open_id ||
      message.senderType !== "user" ||
      message.chatType !== "p2p" ||
      !message.messageId ||
      !message.chatId ||
      !message.text ||
      (channel.chat_id && message.chatId !== channel.chat_id)
    )
      return false;
    const key = `${channelId}:message:${message.messageId}`;
    if (this.store.data.seen.includes(key)) return false;
    this.store.transaction((data) => {
      channel.chat_id = message.chatId;
      data.seen.push(key);
      data.events.push({
        id: randomUUID(),
        key,
        channel_id: channelId,
        kind: "text",
        received_at: this.now(),
        ...(message.sourceTime ? { source_time: message.sourceTime } : {}),
        message_id: message.messageId,
        open_id: message.openId,
        chat_id: message.chatId,
        text: message.text.slice(0, 32000),
        state: channel.session_id ? "pending" : "unassigned",
      });
    });
    this.kick();
    return true;
  }

  receiveAction(channelId: string, action: IncomingAction): Record<string, unknown> {
    const channel = this.channel(channelId);
    if (
      !channel.enabled ||
      action.openId !== channel.authorized_open_id ||
      !action.messageId ||
      !action.chatId ||
      (channel.chat_id && channel.chat_id !== action.chatId)
    )
      return {};
    const card = this.store.data.cards.find(
      (c) => c.id === action.cardId && c.channel_id === channelId,
    );
    if (
      !card ||
      (card.message_id && card.message_id !== action.messageId) ||
      !card.choices.some((c) => c.id === action.actionId)
    )
      return {};
    if (card.state === "pending" || (card.state === "expired" && !card.selected_action)) {
      const expired = card.state === "expired" || this.now() >= card.expires_at;
      const key = `${channelId}:card:${card.id}`;
      this.store.transaction((data) => {
        channel.chat_id = action.chatId;
        card.message_id = action.messageId;
        card.state = expired ? "expired" : "received";
        card.selected_action = action.actionId;
        card.status_text = expired
          ? "已过期，未投递"
          : channel.session_id
            ? "已收到，待 Agent 处理"
            : "已记录，当前无订阅 Session";
        card.dirty = true;
        card.revision++;
        if (!data.seen.includes(key)) {
          data.seen.push(key);
          data.events.push({
            id: randomUUID(),
            key,
            channel_id: channelId,
            kind: "card",
            card_id: card.id,
            action_id: action.actionId,
            received_at: this.now(),
            ...(action.sourceTime ? { source_time: action.sourceTime } : {}),
            message_id: action.messageId,
            open_id: action.openId,
            chat_id: action.chatId,
            text: JSON.stringify({
              title: card.title,
              content: card.content,
              action: action.actionId,
              label: card.choices.find((c) => c.id === action.actionId)?.label,
              created_at: new Date(card.created_at).toISOString(),
              expires_at: new Date(card.expires_at).toISOString(),
              origin_session_id: card.origin_session_id,
            }),
            state: expired ? "expired" : channel.session_id ? "pending" : "unassigned",
          });
        }
      });
      this.kick();
      this.armExpiry();
      this.onCardsChanged();
    }
    const current = this.card(card.id);
    return {
      toast: {
        type: current.state === "expired" ? "info" : "success",
        content: current.status_text ?? "该卡片已处理，请勿重复提交。",
      },
      card: { type: "raw", data: renderCard(current) },
    };
  }

  createCard(
    channelId: string,
    sessionId: string,
    input: { title: unknown; content: unknown; choices: unknown; expires_at: unknown },
  ): Card {
    this.requireOwner(channelId, sessionId);
    const card: Card = {
      id: randomUUID(),
      channel_id: channelId,
      origin_session_id: sessionId,
      title: text(input.title, "卡片标题", 100),
      content: text(input.content, "卡片内容", 12000),
      choices: choices(input.choices),
      created_at: this.now(),
      expires_at: deadline(input.expires_at, this.now()),
      state: "pending",
      dirty: false,
      revision: 1,
    };
    if (Buffer.byteLength(JSON.stringify(renderCard(card)), "utf8") > 28000)
      throw new Error("卡片内容过大，请缩短内容后重新创建。");
    this.store.transaction((data) => {
      data.cards.push(card);
    });
    this.armExpiry();
    return structuredClone(card);
  }
  updateCard(id: string, sessionId: string, revision: unknown, status: unknown): Card {
    const card = this.card(id);
    this.requireOwner(card.channel_id, sessionId);
    if (revision !== card.revision) throw new Error("卡片已变化，请查询最新 revision。");
    const statusText = text(status, "处理结果", 2000);
    this.store.transaction(() => {
      card.state = "completed";
      card.status_text = statusText;
      card.dirty = true;
      card.revision++;
    });
    this.armExpiry();
    this.onCardsChanged();
    return structuredClone(card);
  }

  expireCards() {
    const expired = this.store.data.cards.filter(
      (c) => c.state === "pending" && c.expires_at <= this.now(),
    );
    if (expired.length)
      this.store.transaction(() => {
        for (const card of expired) {
          card.state = "expired";
          card.status_text = "已过期，未投递";
          card.dirty = true;
          card.revision++;
        }
      });
    this.armExpiry();
    if (expired.length) this.onCardsChanged();
  }
  private armExpiry() {
    clearTimeout(this.expiry);
    if (this.stopped) return;
    const next = Math.min(
      ...this.store.data.cards.filter((c) => c.state === "pending").map((c) => c.expires_at),
    );
    if (Number.isFinite(next)) {
      this.expiry = setTimeout(
        () => this.expireCards(),
        Math.min(2147483647, Math.max(1, next - this.now())),
      );
      this.expiry.unref();
    }
  }
  events(channelId?: string, state?: string, limit = 100) {
    return structuredClone(
      this.store.data.events
        .filter((e) => (!channelId || e.channel_id === channelId) && (!state || e.state === state))
        .slice(-Math.max(1, Math.min(500, limit))),
    );
  }

  kick() {
    if (this.stopped || this.scheduled) return;
    this.scheduled = true;
    const launch = () =>
      queueMicrotask(() => {
        this.scheduled = false;
        if (this.stopped) return;
        for (const channel of this.store.data.channels) {
          if (!channel.enabled || !channel.session_id || this.pumping.has(channel.id)) continue;
          const agent = this.host.get(channel.session_id);
          if (
            !agent ||
            this.waiters.has(agent) ||
            !this.store.data.events.some(
              (e) => e.channel_id === channel.id && e.state === "pending",
            )
          )
            continue;
          const task = this.dispatch(channel.id, agent)
            .catch(() => {
              this.host.warn("feishu: 会话投递暂时失败，将保留事件重试。");
              this.retryLater();
            })
            .finally(() => {
              this.pumping.delete(channel.id);
            });
          this.pumping.set(channel.id, task);
        }
      });
    if (this.host.detached) this.host.detached(launch);
    else launch();
  }
  private retryLater() {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.kick();
    }, 5000);
    this.retry.unref();
  }
  async dispatch(channelId: string, agent: A) {
    let maintenance: Promise<void>;
    try {
      maintenance = agent.runMaintenance(async () => {
        while (!this.stopped) {
          const channel = this.channel(channelId);
          if (
            !channel.enabled ||
            !channel.session_id ||
            this.host.get(channel.session_id) !== agent
          )
            return;
          let event = this.store.data.events.find(
            (e) => e.channel_id === channelId && e.state === "pending",
          );
          if (!event) return;
          const eventId = event.id;
          const revision = channel.revision;
          if (!(await this.host.flush(agent))) throw new Error("会话持久化未就绪。");
          // A failed concurrent transaction may have replaced the data snapshot.
          event = this.store.data.events.find((e) => e.id === eventId);
          if (!event) return;
          const current = this.channel(channelId);
          if (
            this.stopped ||
            current.revision !== revision ||
            !current.enabled ||
            !current.session_id ||
            this.host.get(current.session_id) !== agent ||
            event.state !== "pending"
          ) {
            setImmediate(() => this.kick());
            return;
          }
          const target = current.session_id;
          this.store.transaction(() => {
            event.state = "dispatching";
            event.target_session_id = target;
          });
          try {
            this.host.deliver(
              agent,
              `[Feishu ${event.kind === "card" ? "卡片确认" : "用户消息"}]\n通道：${current.label}\n通道 ID：${current.id}\n事件 ID：${event.id}\n消息 ID：${event.message_id}\n收到时间：${new Date(event.received_at).toISOString()}\n${event.card_id ? `卡片 ID：${event.card_id}\n` : ""}\n${event.text}\n\n请处理用户消息并通过飞书通道回复。卡片点击只表达用户意愿，任何实际操作都必须由你按当前情况重新判断。`,
            );
            if (!(await this.host.flush(agent))) throw new Error("投递持久化未确认。");
            this.store.transaction((data) => {
              const latest = data.events.find((e) => e.id === eventId)!;
              latest.state = "delivered";
              latest.delivered_at = this.now();
            });
          } catch {
            this.store.transaction((data) => {
              const latest = data.events.find((e) => e.id === eventId);
              if (latest) latest.state = "uncertain";
            });
            this.host.warn(
              `feishu: 事件 ${event.id} 投递结果不确定，请检查会话记录；不会自动重复投递。`,
            );
          }
        }
      });
    } catch {
      if (!this.waiters.has(agent)) {
        this.waiters.add(agent);
        void Promise.race([agent.whenIdle(), this.stopSignal])
          .catch(() => {})
          .finally(() => {
            this.waiters.delete(agent);
            setImmediate(() => this.kick());
          });
      }
      return;
    }
    await maintenance;
  }

  async close() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.expiry);
    this.signalStop();
    await Promise.allSettled(this.pumping.values());
    this.store.close();
  }
}
