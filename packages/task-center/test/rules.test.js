import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRule, preview, latestOccurrence, nextOccurrence } from "../dist/rules.js";
import { Settings } from "luxon";

test("once preserves local offset across normalization and JSON reload without changing instant", () => {
  const r = normalizeRule({ kind: "once", at: "2026-09-10T15:27:00+08:00" });
  assert.equal(r.at, "2026-09-10T07:27:00.000Z");
  const restored = normalizeRule(JSON.parse(JSON.stringify(r)));
  assert.equal(
    preview(restored, Date.parse("2026-09-10T07:26:00Z"))[0].local,
    "2026-09-10T15:27:00.000+08:00",
  );
  assert.equal(nextOccurrence(restored, 0), Date.parse(r.at));
});
test("interval retains fractional negative offset and supports explicit named timezone", () => {
  const r = normalizeRule({
    kind: "interval",
    anchor: "2026-09-10T09:00:00-03:30",
    every_minutes: 20,
  });
  assert.equal(preview(r, Date.parse(r.anchor))[0].local, "2026-09-10T09:20:00.000-03:30");
  const explicit = normalizeRule({
    kind: "once",
    at: "2026-09-10T07:27:00Z",
    timezone: "Asia/Shanghai",
  });
  assert.equal(preview(explicit, 0)[0].local, "2026-09-10T15:27:00.000+08:00");
  assert.throws(() => normalizeRule({ ...explicit, timezone: "bad-zone" }));
});
test("legacy rules without timezone use host local display; new interval persists host zone", () => {
  const original = Settings.defaultZone;
  try {
    Settings.defaultZone = "Asia/Shanghai";
    const legacy = { kind: "once", at: "2026-09-10T07:27:00.000Z" };
    assert.equal(preview(legacy, 0)[0].local, "2026-09-10T15:27:00.000+08:00");
    const r = normalizeRule({ kind: "interval", every_minutes: 20 }, Date.parse(legacy.at));
    assert.equal(r.timezone, "Asia/Shanghai");
    assert.equal(preview(r, Date.parse(legacy.at))[0].local, "2026-09-10T15:47:00.000+08:00");
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
  const values = preview(r, ms("2026-09-11T09:30:00+08:00"), 13).map((x) => x.local.slice(0, 16));
  assert.deepEqual(values, [
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
  assert.equal(
    preview(r, ms("2026-09-11T00:00:00+08:00"))[0].local.slice(0, 16),
    "2026-09-14T09:31",
  );
  assert.equal(nextOccurrence(r, ms("2026-09-14T11:30:00+08:00")), null);
  assert.equal(
    latestOccurrence(r, ms("2026-09-14T10:15:00+08:00")),
    ms("2026-09-14T10:11:00+08:00"),
  );
});
test("interval remains anchor aligned and coalesces long absences", () => {
  const r = normalizeRule({
    kind: "interval",
    every_minutes: 20,
    anchor: "2026-09-10T09:31:00+08:00",
  });
  assert.equal(nextOccurrence(r, ms("2026-09-10T09:31:00+08:00")), ms("2026-09-10T09:51:00+08:00"));
  assert.equal(
    latestOccurrence(r, ms("2026-09-10T10:30:00+08:00")),
    ms("2026-09-10T10:11:00+08:00"),
  );
});
test("cron month end and weekday, exact latest boundary", () => {
  const r = normalizeRule({ kind: "cron", timezone: "Asia/Shanghai", expression: "0 20 L * *" });
  assert.equal(preview(r, ms("2026-02-01T00:00:00Z"))[0].local.slice(0, 16), "2026-02-28T20:00");
  assert.equal(
    latestOccurrence(r, ms("2026-02-28T20:00:00+08:00")),
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
    assert.throws(() => normalizeRule(rule));
});
test("DST missing local time skipped, repeated local time delivered only once", () => {
  const make = (time) =>
    normalizeRule({
      kind: "windows",
      timezone: "America/New_York",
      weekdays: [7],
      windows: [{ start: time, end: time, every_minutes: 1 }],
    });
  assert.equal(
    preview(make("02:30"), ms("2026-03-08T00:00:00-05:00"), 1)[0].local.slice(0, 10),
    "2026-03-15",
  );
  const r = make("01:30");
  assert.equal(nextOccurrence(r, ms("2026-11-01T00:00:00-04:00")), ms("2026-11-01T01:30:00-04:00"));
  assert.equal(nextOccurrence(r, ms("2026-11-01T01:30:00-04:00")), ms("2026-11-08T01:30:00-05:00"));
});
