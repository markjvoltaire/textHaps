// Run: npx tsx test/reminders.test.mts. Pure functions, no network.
import assert from "node:assert/strict";
import { localTime, reminderTimes, zoneFor } from "../src/reminders/schedule.ts";

const NY = "America/New_York";
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`FAIL ${name}\n  ${err instanceof Error ? err.message : String(err)}`);
  }
}

test("local time follows the clock change: noon is -4 in october, -5 in november", () => {
  assert.equal(iso(localTime("2026-10-20", 12, NY)), "2026-10-20T16:00:00.000Z");
  assert.equal(iso(localTime("2026-11-14", 12, NY)), "2026-11-14T17:00:00.000Z");
  assert.equal(iso(localTime("2026-11-14", 12, "America/Los_Angeles")), "2026-11-14T20:00:00.000Z");
});

test("days before crosses a month", () => {
  assert.equal(iso(localTime("2026-12-01", 18, NY, 2)), "2026-11-29T23:00:00.000Z");
});

test("MOVE, sat nov 14 10pm, saved oct 26: check-in thu 6pm, heads-up sat noon", () => {
  const times = reminderTimes(
    { starts_at: "2026-11-14T22:00:00-05:00", event_date: "2026-11-14" },
    NY,
    Date.parse("2026-10-27T01:00:00Z"),
  );
  assert.equal(iso(times.check_in), "2026-11-12T23:00:00.000Z");
  assert.equal(iso(times.day_of), "2026-11-14T17:00:00.000Z");
});

test("no start time yet still gets both, on the date alone", () => {
  const times = reminderTimes({ starts_at: null, event_date: "2026-11-14" }, NY, Date.parse("2026-10-27T01:00:00Z"));
  assert.ok(times.check_in && times.day_of);
});

test("a day party at 1pm gets its heads-up at 7pm the night before", () => {
  const times = reminderTimes(
    { starts_at: "2026-11-15T13:00:00-05:00", event_date: "2026-11-15" },
    NY,
    Date.parse("2026-10-27T01:00:00Z"),
  );
  assert.equal(iso(times.day_of), "2026-11-15T00:00:00.000Z");
});

test("saved the night before: no check-in, heads-up still goes", () => {
  const times = reminderTimes(
    { starts_at: "2026-11-14T22:00:00-05:00", event_date: "2026-11-14" },
    NY,
    Date.parse("2026-11-14T01:00:00Z"),
  );
  assert.equal(times.check_in, undefined);
  assert.equal(iso(times.day_of), "2026-11-14T17:00:00.000Z");
});

test("saved the day of: nothing to send", () => {
  const times = reminderTimes(
    { starts_at: "2026-11-14T22:00:00-05:00", event_date: "2026-11-14" },
    NY,
    Date.parse("2026-11-14T15:00:00Z"),
  );
  assert.deepEqual(times, {});
});

test("no date: nothing to send", () => {
  assert.deepEqual(reminderTimes({ starts_at: null, event_date: null }, NY), {});
});

test("zone: LA neighborhoods are Pacific, everything else Eastern", () => {
  assert.equal(zoneFor("silver lake"), "America/Los_Angeles");
  assert.equal(zoneFor("miami"), NY);
  assert.equal(zoneFor(null), NY);
});

console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
