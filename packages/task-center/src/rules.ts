import { DateTime } from "luxon";
import { CronExpressionParser } from "cron-parser";
import { isRecord } from "./types.js";
import type { Rule } from "./types.js";

const fail = (message: string): never => {
  throw new Error(message);
};
const iso = (ms: number) => new Date(ms).toISOString();

function instant(value: unknown): number {
  if (typeof value !== "string" || !/(Z|[+-]\d\d:\d\d)$/.test(value))
    return fail("时间必须包含 Z 或 UTC 偏移量。");
  const dt = DateTime.fromISO(value, { setZone: true });
  if (!dt.isValid) fail("无效日期时间。");
  return dt.toMillis();
}

function zone(value: unknown, allowFixed = false): string {
  const fixed =
    allowFixed && typeof value === "string" && /^UTC[+-](?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  if (
    typeof value !== "string" ||
    (value !== "UTC" && !value.includes("/") && !fixed) ||
    !DateTime.now().setZone(value).isValid
  )
    return fail(
      "timezone 必须是 IANA 时区，例如 Asia/Shanghai；once/interval 也支持 UTC+08:00 形式。",
    );
  return value;
}

function clock(value: unknown): number {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
    return fail("窗口时间必须为 HH:mm。");
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}

function only(obj: unknown, keys: string[]): asserts obj is Record<string, unknown> {
  if (!isRecord(obj) || Object.keys(obj).some((k) => !keys.includes(k)))
    fail("规则包含未知字段或格式错误。");
}

export function normalizeRule(raw: unknown, now = Date.now()): Rule {
  only(raw, [
    "kind",
    "at",
    "anchor",
    "every_minutes",
    "timezone",
    "expression",
    "weekdays",
    "windows",
    "exclude_dates",
    "start_date",
    "end_date",
  ]);
  const rule = structuredClone(raw);
  const kinds: Record<string, string[]> = {
    once: ["kind", "at", "timezone"],
    interval: ["kind", "anchor", "every_minutes", "timezone"],
    cron: ["kind", "timezone", "expression"],
    windows: ["kind", "timezone", "weekdays", "windows", "exclude_dates", "start_date", "end_date"],
  };
  const allowed = typeof rule.kind === "string" ? kinds[rule.kind] : undefined;
  if (!allowed) return fail("kind 必须为 once、interval、cron 或 windows。");
  only(rule, allowed);
  if (rule.kind === "once" || rule.kind === "interval") {
    const input = rule.kind === "once" ? rule.at : rule.anchor;
    if (input !== undefined) instant(input);
    // 在转成 UTC 前保留输入偏移；显式命名时区优先，并处理未来的夏令时。
    const offset =
      input === undefined
        ? undefined
        : DateTime.fromISO(input as string, { setZone: true }).toFormat("ZZ");
    rule.timezone = zone(
      rule.timezone ??
        (offset === undefined
          ? DateTime.local().zoneName
          : offset === "+00:00"
            ? "UTC"
            : `UTC${offset}`),
      true,
    );
  }
  if (rule.kind === "once") rule.at = iso(instant(rule.at));
  if (rule.kind === "interval") {
    minutes(rule.every_minutes);
    rule.anchor =
      rule.anchor === undefined ? iso(now + rule.every_minutes * 60000) : iso(instant(rule.anchor));
  }
  if (rule.kind === "cron" || rule.kind === "windows") rule.timezone = zone(rule.timezone);
  if (rule.kind === "cron") {
    if (
      typeof rule.expression !== "string" ||
      rule.expression.trim().split(/\s+/).length !== 5 ||
      /H/.test(rule.expression)
    )
      return fail("使用确定性的五字段 cron（分钟 小时 日 月 星期），不支持 H 随机规则。");
    const parts = rule.expression.trim().split(/\s+/);
    if (parts[2] !== "*" && parts[4] !== "*")
      fail("cron 的日与星期不能同时受限，请拆分任务以避免 OR/AND 歧义。");
    CronExpressionParser.parse(rule.expression, {
      tz: rule.timezone as string,
      currentDate: now,
    }).next();
  }
  if (rule.kind === "windows") {
    if (
      !Array.isArray(rule.weekdays) ||
      !rule.weekdays.length ||
      (rule.weekdays as unknown[]).some(
        (d) => typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 7,
      )
    )
      return fail("weekdays 使用 1（周一）至 7（周日）。");
    rule.weekdays = [...new Set(rule.weekdays as number[])].sort((a, b) => a - b);
    if (!Array.isArray(rule.windows) || !rule.windows.length || rule.windows.length > 24)
      return fail("需要 1 至 24 个时间窗口。");
    for (const w of rule.windows as unknown[]) {
      only(w, ["start", "end", "every_minutes"]);
      if (clock(w.start) > clock(w.end)) fail("跨午夜窗口请拆为两个任务或窗口。");
      minutes(w.every_minutes);
    }
    for (const key of ["start_date", "end_date"]) if (rule[key] !== undefined) date(rule[key]);
    if (
      typeof rule.start_date === "string" &&
      typeof rule.end_date === "string" &&
      rule.start_date > rule.end_date
    )
      fail("start_date 必须不晚于 end_date。");
    rule.exclude_dates ??= [];
    if (!Array.isArray(rule.exclude_dates) || rule.exclude_dates.length > 3660)
      return fail("exclude_dates 必须是日期数组，最多 3660 项。");
    (rule.exclude_dates as unknown[]).forEach(date);
  }
  // 各分支在上方完成运行时校验，落盘结构继续使用既有的判别联合。
  return rule as unknown as Rule;
}

function minutes(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 5256000)
    fail("every_minutes 必须是 1 至 5256000 的整数。");
}

function date(value: unknown): void {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !DateTime.fromISO(value).isValid
  )
    fail("日期必须为有效 YYYY-MM-DD。");
}

function dayCandidates(rule: Extract<Rule, { kind: "windows" }>, day: DateTime<true>): number[] {
  const key = day.toISODate();
  if (
    !rule.weekdays.includes(day.weekday) ||
    rule.exclude_dates.includes(key) ||
    (rule.start_date && key < rule.start_date) ||
    (rule.end_date && key > rule.end_date)
  )
    return [];
  const values = new Set<number>();
  for (const w of rule.windows) {
    for (let m = clock(w.start); m <= clock(w.end); m += w.every_minutes) {
      const dt = day.set({ hour: Math.floor(m / 60), minute: m % 60, second: 0, millisecond: 0 });
      // 跳过不存在的本地时间；夏令时重叠时只取较早的那个时刻。
      if (dt.hour !== Math.floor(m / 60) || dt.minute !== m % 60) continue;
      values.add(Math.min(...dt.getPossibleOffsets().map((d) => d.toMillis())));
    }
  }
  return [...values].sort((a, b) => a - b);
}

function windowOccurrence(
  rule: Extract<Rule, { kind: "windows" }>,
  pivot: number,
  direction: 1 | -1,
): number | null {
  let day = DateTime.fromMillis(pivot, { zone: rule.timezone }).startOf("day") as DateTime<true>;
  if (direction > 0 && rule.start_date && day.toISODate() < rule.start_date)
    day = DateTime.fromISO(rule.start_date, { zone: rule.timezone }) as DateTime<true>;
  if (direction < 0 && rule.end_date && day.toISODate() > rule.end_date)
    day = DateTime.fromISO(rule.end_date, { zone: rule.timezone }) as DateTime<true>;
  for (let n = 0; n < 3661; n++, day = day.plus({ days: direction })) {
    if (
      (direction > 0 && rule.end_date && day.toISODate() > rule.end_date) ||
      (direction < 0 && rule.start_date && day.toISODate() < rule.start_date)
    )
      return null;
    const candidates = dayCandidates(rule, day).filter((t) =>
      direction > 0 ? t > pivot : t <= pivot,
    );
    if (candidates.length) return direction > 0 ? candidates[0] : candidates.at(-1)!;
  }
  return null;
}

export function nextOccurrence(rule: Rule, after: number): number | null {
  if (rule.kind === "once") return Date.parse(rule.at) > after ? Date.parse(rule.at) : null;
  if (rule.kind === "interval") {
    const anchor = Date.parse(rule.anchor),
      step = rule.every_minutes * 60000;
    return anchor + Math.max(0, Math.floor((after - anchor) / step) + 1) * step;
  }
  if (rule.kind === "windows") return windowOccurrence(rule, after, 1);
  return CronExpressionParser.parse(rule.expression, { tz: rule.timezone, currentDate: after })
    .next()
    .getTime();
}

export function latestOccurrence(rule: Rule, now: number): number | null {
  if (rule.kind === "once") return Date.parse(rule.at) <= now ? Date.parse(rule.at) : null;
  if (rule.kind === "interval") {
    const anchor = Date.parse(rule.anchor),
      step = rule.every_minutes * 60000;
    return now < anchor ? null : anchor + Math.floor((now - anchor) / step) * step;
  }
  if (rule.kind === "windows") return windowOccurrence(rule, now, -1);
  return CronExpressionParser.parse(rule.expression, { tz: rule.timezone, currentDate: now + 1 })
    .prev()
    .getTime();
}

export function preview(rule: Rule, after = Date.now(), count = 5) {
  const result: { utc: string; local: string | null }[] = [];
  for (let i = 0; i < Math.min(20, count); i++) {
    const next = nextOccurrence(rule, after);
    if (next === null) break;
    result.push({
      utc: iso(next),
      local: DateTime.fromMillis(next, {
        zone: rule.timezone ?? DateTime.local().zoneName,
      }).toISO(),
    });
    after = next;
  }
  return result;
}
