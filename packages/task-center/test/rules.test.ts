import { test, expect } from "vitest";
import { normalizeRule, preview, latestOccurrence, nextOccurrence } from "../src/rules.js";
import type { Rule } from "../src/types.js";
import { Settings } from "luxon";

test("once preserves local offset across normalization and JSON reload without changing instant", () => {
  const r = normalizeRule({ kind: "once", at: "2026-09-10T15:27:00+08:00" });
  if (r.kind !== "once") throw new Error("Expected one-shot rule");
  expect(r.at).toBe("2026-09-10T07:27:00.000Z");
  const restored = normalizeRule(JSON.parse(JSON.stringify(r)));
  expect(preview(restored, Date.parse("2026-09-10T07:26:00Z"))[0].local).toBe(
    "2026-09-10T15:27:00.000+08:00",
  );
  expect(nextOccurrence(restored, 0)).toBe(Date.parse(r.at));
});
test("interval retains fractional negative offset and supports explicit named timezone", () => {
  const r = normalizeRule({
    kind: "interval",
    anchor: "2026-09-10T09:00:00-03:30",
    every_minutes: 20,
  });
  if (r.kind !== "interval") throw new Error("Expected interval rule");
  expect(preview(r, Date.parse(r.anchor))[0].local).toBe("2026-09-10T09:20:00.000-03:30");
  const explicit = normalizeRule({
    kind: "once",
    at: "2026-09-10T07:27:00Z",
    timezone: "Asia/Shanghai",
  });
  expect(preview(explicit, 0)[0].local).toBe("2026-09-10T15:27:00.000+08:00");
  expect(() => normalizeRule({ ...explicit, timezone: "bad-zone" })).toThrow();
});
test("legacy rules without timezone use host local display; new interval persists host zone", () => {
  const original = Settings.defaultZone;
  try {
    Settings.defaultZone = "Asia/Shanghai";
    const legacy: Rule = { kind: "once", at: "2026-09-10T07:27:00.000Z" };
    expect(preview(legacy, 0)[0].local).toBe("2026-09-10T15:27:00.000+08:00");
    const r = normalizeRule({ kind: "interval", every_minutes: 20 }, Date.parse(legacy.at));
    expect(r.timezone).toBe("Asia/Shanghai");
    expect(preview(r, Date.parse(legacy.at))[0].local).toBe("2026-09-10T15:47:00.000+08:00");
  } finally {
    Settings.defaultZone = original;
  }
});

const ms = Date.parse;
const sample = {
  kind: "windows",
  timezone: "Asia/Shanghai",
  weekdays: [1, 2, 3, 4, 5],
  windows: [
    { start: "09:31", end: "11:30", every_minutes: 20 },
    { start: "13:01", end: "15:00", every_minutes: 20 },
  ],
};
test("morning and afternoon independently align to starts, skip lunch and weekend", () => {
  const r = normalizeRule(sample);
  const values = preview(r, ms("2026-09-11T09:30:00+08:00"), 13).map((x) => x.local!.slice(0, 16));
  expect(values).toEqual([
    "2026-09-11T09:31",
    "2026-09-11T09:51",
    "2026-09-11T10:11",
    "2026-09-11T10:31",
    "2026-09-11T10:51",
    "2026-09-11T11:11",
    "2026-09-11T13:01",
    "2026-09-11T13:21",
    "2026-09-11T13:41",
    "2026-09-11T14:01",
    "2026-09-11T14:21",
    "2026-09-11T14:41",
    "2026-09-14T09:31",
  ]);
});
test("exclude dates, date bounds and overlapping windows", () => {
  const r = normalizeRule({
    ...sample,
    windows: [sample.windows[0], sample.windows[0]],
    exclude_dates: ["2026-09-11"],
    end_date: "2026-09-14",
  });
  expect(preview(r, ms("2026-09-11T00:00:00+08:00"))[0].local!.slice(0, 16)).toBe(
    "2026-09-14T09:31",
  );
  expect(nextOccurrence(r, ms("2026-09-14T11:30:00+08:00"))).toBe(null);
  expect(latestOccurrence(r, ms("2026-09-14T10:15:00+08:00"))).toBe(
    ms("2026-09-14T10:11:00+08:00"),
  );
});
test("interval remains anchor aligned and coalesces long absences", () => {
  const r = normalizeRule({
    kind: "interval",
    every_minutes: 20,
    anchor: "2026-09-10T09:31:00+08:00",
  });
  expect(nextOccurrence(r, ms("2026-09-10T09:31:00+08:00"))).toBe(ms("2026-09-10T09:51:00+08:00"));
  expect(latestOccurrence(r, ms("2026-09-10T10:30:00+08:00"))).toBe(
    ms("2026-09-10T10:11:00+08:00"),
  );
});
test("cron month end and weekday, exact latest boundary", () => {
  const r = normalizeRule({ kind: "cron", timezone: "Asia/Shanghai", expression: "0 20 L * *" });
  expect(preview(r, ms("2026-02-01T00:00:00Z"))[0].local!.slice(0, 16)).toBe("2026-02-28T20:00");
  expect(latestOccurrence(r, ms("2026-02-28T20:00:00+08:00"))).toBe(
    ms("2026-02-28T20:00:00+08:00"),
  );
});
test("invalid and ambiguous inputs rejected", () => {
  for (const rule of [
    { kind: "once", at: "2026-02-30T10:00:00Z" },
    { kind: "once", at: "2026-12-01T10:00:00" },
    { kind: "interval", every_minutes: 0 },
    { ...sample, timezone: "bogus" },
    { ...sample, windows: [{ start: "23:00", end: "01:00", every_minutes: 20 }] },
    { kind: "cron", timezone: "UTC", expression: "0 0 1 * 1" },
    { ...sample, extra: 1 },
  ])
    expect(() => normalizeRule(rule)).toThrow();
});
test("DST missing local time skipped, repeated local time delivered only once", () => {
  const make = (time: string) =>
    normalizeRule({
      kind: "windows",
      timezone: "America/New_York",
      weekdays: [7],
      windows: [{ start: time, end: time, every_minutes: 1 }],
    });
  expect(preview(make("02:30"), ms("2026-03-08T00:00:00-05:00"), 1)[0].local!.slice(0, 10)).toBe(
    "2026-03-15",
  );
  const r = make("01:30");
  expect(nextOccurrence(r, ms("2026-11-01T00:00:00-04:00"))).toBe(ms("2026-11-01T01:30:00-04:00"));
  expect(nextOccurrence(r, ms("2026-11-01T01:30:00-04:00"))).toBe(ms("2026-11-08T01:30:00-05:00"));
});
