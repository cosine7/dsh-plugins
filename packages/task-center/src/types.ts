/** 持久化结构沿用任务中心 v1 格式，迁移工程目录不迁移用户数据。 */
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
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  rule: Rule;
  target_session_id: string;
  revision: number;
  enabled: boolean;
  next_at: number | null;
  created_at: number;
  dispatching?: Delivery;
  last_delivery?: Delivery;
  error?: string;
}

export interface HistoryEntry extends Delivery {
  task_id: string;
  state: "delivered";
}

export interface StoreData {
  version: 1;
  tasks: Task[];
  history: HistoryEntry[];
}

export interface MaintenanceAgent {
  runMaintenance(operation: () => Promise<void>): Promise<void>;
  whenIdle(): Promise<void>;
}

export interface TaskCenterHost<A extends MaintenanceAgent> {
  get(id: string): A | undefined;
  flush(agent: A): Promise<boolean>;
  deliver(agent: A, text: string): unknown;
  detached?(operation: () => void): void;
  warn(text: string): void;
}

export interface CreateTaskInput {
  title?: unknown;
  prompt?: unknown;
  rule?: unknown;
  target_session_id?: unknown;
}

export interface TaskChanges {
  title?: string;
  prompt?: string;
  rule?: Rule;
  enabled?: boolean;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
