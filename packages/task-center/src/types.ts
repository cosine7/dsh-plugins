export interface FeishuBinding {
  channel_id: string;
  session_id: string;
  revision: number;
}

export interface Preparation {
  session_id: string;
  occurrence_at: number;
  original_session_id?: string;
  reason?: "archived" | "missing";
}
export interface WindowRule {
  start: string;
  end: string;
  every_minutes: number;
}

export type Rule =
  | { kind: "once"; at: string; timezone?: string }
  | { kind: "interval"; anchor: string; every_minutes: number; timezone?: string }
  | { kind: "cron"; expression: string; timezone: string }
  | {
      kind: "windows";
      timezone: string;
      weekdays: number[];
      windows: WindowRule[];
      exclude_dates: string[];
      start_date?: string;
      end_date?: string;
    };

export interface Delivery {
  id: string;
  occurrence_at: number;
  target_session_id: string;
  accepted_at: number;
  original_session_id?: string;
  replacement_reason?: "archived" | "missing";
  feishu_handoff?: FeishuHandoff;
}

export interface FeishuHandoff {
  state: "succeeded" | "failed";
  target_session_id: string;
  channel_ids: string[];
  error?: string;
}

export interface Task {
  id: string;
  title: string;
  session_title?: string;
  prompt: string;
  rule: Rule;
  target_mode: "session" | "new";
  target_session_id?: string;
  cwd: string;
  feishu_bindings: FeishuBinding[];
  preparing?: Preparation;
  revision: number;
  enabled: boolean;
  next_at: number | null;
  created_at: number;
  dispatching?: Delivery;
  last_delivery?: Delivery;
  error?: string;
  feishu_handoff?: FeishuHandoff;
}

export interface HistoryEntry extends Delivery {
  task_id: string;
  state: "delivered";
}

export interface StoreData {
  version: 2;
  tasks: Task[];
  history: HistoryEntry[];
}

export interface MaintenanceAgent {
  runMaintenance(operation: () => Promise<void>): Promise<void>;
  whenIdle(): Promise<void>;
}

export interface TaskCenterHost<A extends MaintenanceAgent> {
  get(id: string): A | undefined;
  describe(id: string): Promise<{ state: "available" | "archived" | "missing"; cwd?: string }>;
  resolve(id: string): Promise<A>;
  create(cwd: string, id: string): Promise<{ id: string; agent: A }>;
  name(agent: A, title: string): Promise<void>;
  handoff(bindings: FeishuBinding[], target: string): Promise<FeishuBinding[]>;
  archived(id: string): boolean;
  flush(agent: A): Promise<boolean>;
  deliver(agent: A, text: string): unknown;
  detached?(operation: () => void): void;
  warn(text: string): void;
  notify?(key: string, message: string, channelIds?: string[]): Promise<void>;
}

export interface CreateTaskInput {
  title?: unknown;
  session_title?: unknown;
  prompt?: unknown;
  rule?: unknown;
  target_session_id?: unknown;
  target_mode?: unknown;
  cwd?: unknown;
  feishu_bindings?: FeishuBinding[];
}

export interface TaskChanges {
  title?: string;
  session_title?: string;
  prompt?: string;
  rule?: Rule;
  enabled?: boolean;
  cwd?: string;
  target_mode?: "session" | "new";
  feishu_bindings?: FeishuBinding[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validBindings(value: unknown): value is FeishuBinding[] {
  return (
    Array.isArray(value) &&
    value.every(
      (binding: unknown) =>
        isRecord(binding) &&
        typeof binding.channel_id === "string" &&
        !!binding.channel_id &&
        typeof binding.session_id === "string" &&
        !!binding.session_id &&
        Number.isInteger(binding.revision) &&
        Number(binding.revision) > 0,
    ) &&
    new Set(value.map((binding) => binding.channel_id)).size === value.length
  );
}

export function validHandoff(value: unknown): value is FeishuHandoff {
  return (
    isRecord(value) &&
    ["succeeded", "failed"].includes(String(value.state)) &&
    typeof value.target_session_id === "string" &&
    Array.isArray(value.channel_ids) &&
    value.channel_ids.every((id: unknown) => typeof id === "string") &&
    (value.state !== "failed" || typeof value.error === "string")
  );
}

export function validateSessionTitle(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 200 || /[\r\n]/.test(value))
    throw new Error("session_title 必须是 1–200 字符的非空单行标题。");
  return value.trim();
}
