"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { normalizePhone } = require("../lib/phone");
const { verifyRetellSignature, signForTest } = require("../lib/retellSignature");
const { inWindow, nextInWindow, retryWindowFromEnv, callbackWindowFor } = require("../lib/callingWindow");
const { resolveTimeZone } = require("../lib/timezones");
const { pickFreeSlots, pickAround, combineAvailability, isPlausibleEmail } = require("../lib/booking");

test("normalizePhone keeps E.164 and fixes US formats", () => {
  assert.equal(normalizePhone("+1 (312) 899-3097"), "+13128993097");
  assert.equal(normalizePhone("3128993097"), "+13128993097");
  assert.equal(normalizePhone("13128993097"), "+13128993097");
  assert.equal(normalizePhone("+919873370176"), "+919873370176");
});

test("normalizePhone rejects junk instead of guessing", () => {
  assert.equal(normalizePhone("{{callback_phone}}"), null);
  assert.equal(normalizePhone("12345"), null);
  assert.equal(normalizePhone(""), null);
  assert.equal(normalizePhone(null), null);
  // Old code turned this into "+4155551234" (a non-US number).
  assert.notEqual(normalizePhone("415-555-1234"), "+4155551234");
});

test("Retell signature verifies and rejects tampering", () => {
  const key = "key_test_123";
  const body = JSON.stringify({ event: "call_analyzed", call: { call_id: "c1" } });
  const now = Date.now();
  const header = signForTest(body, key, now);

  assert.equal(verifyRetellSignature(body, key, header, { now }), true);
  assert.equal(verifyRetellSignature(body + " ", key, header, { now }), false);
  assert.equal(verifyRetellSignature(body, "wrong_key", header, { now }), false);
  assert.equal(verifyRetellSignature(body, key, undefined, { now }), false);
  assert.equal(verifyRetellSignature(body, key, "garbage", { now }), false);
  // Old signatures (replay) are rejected.
  assert.equal(verifyRetellSignature(body, key, header, { now: now + 10 * 60 * 1000 }), false);
  // GET requests sign the empty string.
  assert.equal(verifyRetellSignature("", key, signForTest("", key, now), { now }), true);
});

test("retry window: weekdays 11:00-17:00 Eastern by default", () => {
  const w = retryWindowFromEnv({});
  // Wed 2026-11-11 15:00 UTC = 10:00 ET -> closed; 16:00 UTC = 11:00 ET -> open
  assert.equal(inWindow(new Date("2026-11-11T15:00:00Z"), w), false);
  assert.equal(inWindow(new Date("2026-11-11T16:00:00Z"), w), true);
  // 22:00 UTC = 17:00 ET -> closed
  assert.equal(inWindow(new Date("2026-11-11T22:00:00Z"), w), false);
  // Saturday midday -> closed
  assert.equal(inWindow(new Date("2026-11-14T17:00:00Z"), w), false);
});

test("retry window: a Friday-evening retry moves to Monday 11:00 ET", () => {
  const w = retryWindowFromEnv({});
  const fridayEvening = new Date("2026-11-13T23:30:00Z"); // 18:30 ET Friday
  const next = nextInWindow(fridayEvening, w);
  assert.equal(next.toISOString(), "2026-11-16T16:00:00.000Z"); // Mon 11:00 ET
});

test("callback window uses the prospect's zone, 08:00-21:00", () => {
  const pacific = callbackWindowFor("America/Los_Angeles");
  // 15:30 UTC = 07:30 PT -> too early; 16:00 UTC = 08:00 PT -> fine
  assert.equal(inWindow(new Date("2026-11-11T15:30:00Z"), pacific), false);
  assert.equal(inWindow(new Date("2026-11-11T16:00:00Z"), pacific), true);
  // Saturday is allowed for a requested callback
  assert.equal(inWindow(new Date("2026-11-14T18:00:00Z"), pacific), true);
  // Unknown zone falls back to 11:00-21:00 Eastern
  const unknown = callbackWindowFor("UTC");
  assert.equal(unknown.timeZone, "America/New_York");
});

test("time zone resolution", () => {
  assert.equal(resolveTimeZone({ state: "Ohio" }).time_zone, "America/New_York");
  assert.equal(resolveTimeZone({ state: "OH", country: "USA" }).time_zone, "America/New_York");
  assert.equal(resolveTimeZone({ state: "Texas", city: "El Paso" }).time_zone, "America/Denver");
  assert.equal(resolveTimeZone({ country: "India" }).time_zone, "Asia/Kolkata");
  // Indiana is split: Gary is Central, Fort Wayne is Eastern, unknown -> ask.
  assert.equal(resolveTimeZone({ state: "Indiana", city: "Gary" }).time_zone, "America/Chicago");
  assert.equal(resolveTimeZone({ state: "IN", city: "Fort Wayne" }).time_zone, "America/New_York");
  assert.equal(resolveTimeZone({ state: "Indiana" }).success, false);
  assert.equal(resolveTimeZone({ country: "Canada" }).success, false);
  assert.equal(resolveTimeZone({}).success, false);
});

test("pickFreeSlots offers weekday slots inside demo hours", () => {
  // Window starts Fri 2026-11-13 09:00 ET (14:00 UTC), 30-min intervals.
  // Slot 0 busy, slot 1 free (09:30 ET), then free until evening, then the
  // weekend, so only Friday slots should be offered.
  const view = "2" + "0".repeat(60);
  const slots = pickFreeSlots({
    availabilityView: view,
    windowStart: new Date("2026-11-13T14:00:00Z"),
    intervalMinutes: 30,
    timeZone: "America/New_York",
    earliest: new Date("2026-11-13T12:00:00Z"),
    startHour: 9,
    endHour: 17,
    count: 3
  });
  assert.equal(slots.length, 3);
  assert.equal(slots[0].start, "2026-11-13T14:30:00.000Z");
  assert.match(slots[0].label, /Friday, Nov 13.*9:30/);

  // A 16:45 start would end after 17:00, so the last offered slot is 16:30.
  const late = pickFreeSlots({
    availabilityView: "0".repeat(20),
    windowStart: new Date("2026-11-13T21:00:00Z"), // 16:00 ET Friday
    intervalMinutes: 30,
    timeZone: "America/New_York",
    earliest: new Date("2026-11-13T00:00:00Z"),
    count: 5
  });
  assert.deepEqual(late.map(s => s.start), ["2026-11-13T21:00:00.000Z", "2026-11-13T21:30:00.000Z"]);
});

test("pickFreeSlots can offer one slot per day", () => {
  // Thu 2026-11-12 00:00 ET (05:00 UTC), 4 days of 30-min intervals, all free.
  const slots = pickFreeSlots({
    availabilityView: "0".repeat(4 * 48),
    windowStart: new Date("2026-11-12T05:00:00Z"),
    intervalMinutes: 30,
    timeZone: "America/New_York",
    earliest: new Date("2026-11-12T05:00:00Z"),
    startHour: 9,
    endHour: 17,
    count: 3,
    distinctDays: true
  });
  // Thu morning 09:00, Fri afternoon 13:00, then the weekend -> Mon is beyond 4 days, so 2.
  assert.deepEqual(slots.map(s => s.start), ["2026-11-12T14:00:00.000Z", "2026-11-13T18:00:00.000Z"]);
});

test("combineAvailability is free only when everyone is free", () => {
  assert.equal(combineAvailability(["0002", "0200"]), "0202");
  assert.equal(combineAvailability(["000"]), "000");
  assert.equal(combineAvailability([]), "");
});

test("demo slots respect the US team's hours", () => {
  // Prospect in New York, team in Los Angeles (08:00-17:00 PT).
  // Window starts Thu 2026-11-12 09:00 ET (14:00 UTC), all free.
  const slots = pickFreeSlots({
    availabilityView: "0".repeat(20),
    windowStart: new Date("2026-11-12T14:00:00Z"),
    intervalMinutes: 30,
    timeZone: "America/New_York",
    earliest: new Date("2026-11-12T00:00:00Z"),
    startHour: 9,
    endHour: 17,
    count: 1,
    teamWindow: { timeZone: "America/Los_Angeles", startHour: 8, endHour: 17 }
  });
  // 9:00-10:30 ET is before 8:00 PT, so the first slot is 11:00 ET (8:00 PT).
  assert.equal(slots[0].start, "2026-11-12T16:00:00.000Z");
});

test("email sanity check", () => {
  assert.equal(isPlausibleEmail("anshul_gupta@ripik.ai"), true);
  assert.equal(isPlausibleEmail("anshul at ripik dot ai"), false);
  assert.equal(isPlausibleEmail("x@y"), false);
});

test("pickAround offers times near a requested time, or morning and afternoon for a day", () => {
  // Thu 2026-11-12 00:00 ET (05:00 UTC), 6 days of 30-min intervals.
  // Thursday 16:00 ET (slot 32) is busy; everything else is free.
  const view = "0".repeat(32) + "2" + "0".repeat(6 * 48 - 33);
  const base = {
    availabilityView: view,
    windowStart: new Date("2026-11-12T05:00:00Z"),
    intervalMinutes: 30,
    timeZone: "America/New_York",
    earliest: new Date("2026-11-12T00:00:00Z"),
    startHour: 9,
    endHour: 19
  };

  // "Thursday at 4" is taken: offer 3:30 and 4:30 that day.
  const near = pickAround({ ...base, target: new Date("2026-11-12T21:00:00Z"), mode: "near", count: 2 });
  assert.deepEqual(near.map(s => s.start), ["2026-11-12T20:30:00.000Z", "2026-11-12T21:30:00.000Z"]);

  // "Thursday": first morning and first afternoon that day.
  const spread = pickAround({ ...base, target: new Date("2026-11-12T05:00:00Z"), mode: "spread", count: 2 });
  assert.deepEqual(spread.map(s => s.start), ["2026-11-12T14:00:00.000Z", "2026-11-12T18:00:00.000Z"]);

  // "Saturday at noon": nothing that day, so Monday morning and Tuesday afternoon.
  const weekend = pickAround({ ...base, target: new Date("2026-11-14T17:00:00Z"), mode: "near", count: 2 });
  assert.deepEqual(weekend.map(s => s.start), ["2026-11-16T14:00:00.000Z", "2026-11-17T18:00:00.000Z"]);
});

const { leadVariables, leadTimeZone, followUpWindow, retryPlan, continueChain, firstDelayMs, nextDelayMs } = require("../lib/followUp");

test("retryPlan follows the day-1 rules", () => {
  const base = { inVoicemail: false, prospectOutcome: "no_meaningful_conversation", automaticRetryAllowed: true, demoIntentIncomplete: false };
  assert.deepEqual(retryPlan({ ...base, disconnectReason: "dial_no_answer" }), { retry: true, type: "standard" });
  assert.deepEqual(retryPlan({ ...base, disconnectReason: "user_hangup" }), { retry: true, type: "hung_up" });
  assert.deepEqual(retryPlan({ ...base, disconnectReason: "user_declined" }), { retry: true, type: "hung_up" });
  assert.equal(retryPlan({ ...base, disconnectReason: "ivr_reached" }).retry, false);
  assert.equal(retryPlan({ ...base, disconnectReason: "invalid_destination" }).retry, false);
  assert.deepEqual(retryPlan({ ...base, disconnectReason: "voicemail_reached", inVoicemail: true }), { retry: true, type: "voicemail" });
  assert.equal(retryPlan({ ...base, disconnectReason: "agent_hangup", prospectOutcome: "not_interested" }).retry, false);
  assert.deepEqual(retryPlan({ ...base, disconnectReason: "agent_hangup", demoIntentIncomplete: true }), { retry: true, type: "demo_recovery" });

  // A chain stops once someone picks up and hangs up.
  assert.equal(continueChain(retryPlan({ ...base, disconnectReason: "user_hangup" })), false);
  assert.equal(continueChain(retryPlan({ ...base, disconnectReason: "dial_no_answer" })), true);

  assert.equal(firstDelayMs("standard"), 2 * 3600e3);
  assert.equal(firstDelayMs("hung_up"), 72 * 3600e3);
  assert.equal(nextDelayMs("hung_up", 1), null);
  assert.equal(nextDelayMs("standard", 1), 24 * 3600e3);
  assert.equal(nextDelayMs("standard", 2), null);
  assert.equal(nextDelayMs("voicemail", 1), 72 * 3600e3);
});

test("follow-ups keep lead details and use the prospect's own hours", () => {
  const vars = leadVariables({ prospect_name: "Ben Beard", company: "Hecla Mining", industry: "Mining", state: "Alaska", city: "Juneau", country: "United States", title: "", email: "{{email}}", junk: "x" });
  assert.deepEqual(vars, { prospect_name: "Ben Beard", company: "Hecla Mining", industry: "Mining", city: "Juneau", state: "Alaska", country: "United States" });
  assert.equal(leadTimeZone(vars), "America/Anchorage");
  const fallback = { timeZone: "America/New_York", startHour: 11, endHour: 17, weekdaysOnly: true };
  assert.deepEqual(followUpWindow("America/Anchorage", fallback), { timeZone: "America/Anchorage", startHour: 9, endHour: 17, weekdaysOnly: true });
  assert.deepEqual(followUpWindow(null, fallback), fallback);
});
