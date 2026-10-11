export interface Channel {
  id: string;
  label: string;
  app_id_ref: string;
  app_secret_ref: string;
  authorized_open_id: string;
  enabled: boolean;
  revision: number;
  session_id?: string;
  chat_id?: string;
}

export type EventState =
  | "pending"
  | "unassigned"
  | "dispatching"
  | "delivered"
  | "uncertain"
  | "expired";
export interface InboundEvent {
  id: string;
  key: string;
  channel_id: string;
  kind: "text" | "card";
  received_at: number;
  source_time?: string;
  message_id: string;
  open_id: string;
  chat_id: string;
  text: string;
  state: EventState;
  card_id?: string;
  action_id?: string;
  target_session_id?: string;
  delivered_at?: number;
}

export interface Choice {
  id: string;
  label: string;
}
export interface Card {
  id: string;
  channel_id: string;
  origin_session_id: string;
  title: string;
  content: string;
  choices: Choice[];
  created_at: number;
  expires_at: number;
  state: "pending" | "received" | "expired" | "completed";
  selected_action?: string;
  status_text?: string;
  message_id?: string;
  dirty: boolean;
  revision: number;
}

export interface Outbound {
  id: string;
  channel_id: string;
  origin_session_id: string;
  content: string;
  card_id?: string;
  created_at: number;
  state: "sending" | "sent" | "uncertain";
  message_id?: string;
}

export interface StoreData {
  version: 1;
  channels: Channel[];
  events: InboundEvent[];
  cards: Card[];
  outbound: Outbound[];
  seen: string[];
}

export interface MaintenanceAgent {
  runMaintenance(operation: () => Promise<void>): Promise<void>;
  whenIdle(): Promise<void>;
}
export interface Host<A extends MaintenanceAgent> {
  get(id: string): A | undefined;
  flush(agent: A): Promise<boolean>;
  deliver(agent: A, text: string): unknown;
  warn(message: string): void;
  detached?(operation: () => void): void;
}
export interface IncomingMessage {
  messageId: string;
  openId: string;
  chatId: string;
  chatType: string;
  senderType: string;
  text: string;
  sourceTime?: string;
}
export interface IncomingAction {
  eventId: string;
  messageId: string;
  openId: string;
  chatId: string;
  cardId: string;
  actionId: string;
  sourceTime?: string;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function text(value: unknown, label: string, max = 16000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error(`${label} 必须是 1–${max} 字符的文本。`);
  return value;
}
export function identifier(value: unknown, prefix: string): string {
  const result = text(value, prefix, 128);
  if (!new RegExp(`^${prefix}[A-Za-z0-9_-]+$`).test(result))
    throw new Error(`${prefix} 标识无效。`);
  return result;
}
/** Network errors can carry the entire credential-bearing Axios request. Never stringify them. */
export function safeError(error: unknown): string {
  const candidate = record(error) ? error.code : undefined;
  const code =
    typeof candidate === "number" && Number.isFinite(candidate)
      ? String(candidate)
      : typeof candidate === "string" &&
          [
            "ETIMEDOUT",
            "ECONNRESET",
            "ECONNREFUSED",
            "ENOTFOUND",
            "EAI_AGAIN",
            "ERR_NETWORK",
            "ERR_CANCELED",
            "ECONNABORTED",
          ].includes(candidate)
        ? candidate
        : "unknown";
  return `操作失败（code=${code}）。请检查连接、凭据和飞书应用配置。`;
}
