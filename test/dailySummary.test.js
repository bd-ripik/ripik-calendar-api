"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { summarizeCalls, warnings, renderSummaryPage } = require("../lib/dailySummary");

const rows = [
  { disconnection_reason: "voicemail_reached", in_voicemail: true, details: { direction: "outbound" } },
  { disconnection_reason: "user_hangup", duration_ms: 45000, prospect_outcome: "callback_requested", details: { direction: "outbound" } },
  { disconnection_reason: "ivr_reached", details: { direction: "outbound" } },
  { disconnection_reason: "user_hangup", duration_ms: 3000, details: { direction: "inbound" } },
  { disconnection_reason: "credit_exhausted", details: { direction: "inbound" } }
];

test("summarizeCalls counts each kind of call once", () => {
  const s = summarizeCalls(rows);
  assert.equal(s.outbound, 3);
  assert.equal(s.inbound, 1);
  assert.equal(s.voicemail, 1);
  assert.equal(s.phoneMenu, 1);
  assert.equal(s.reached, 1);
  assert.equal(s.talked30, 1);
  assert.equal(s.creditExhausted, 1);
  assert.equal(s.outcomes.callback_requested, 1);
});

test("warnings flag credit problems, failed calls and a silent weekday", () => {
  const w = warnings({
    stats: { creditExhausted: 2, outbound: 0 },
    dialErrors: [{ at: 1, message: "Retell call failed" }],
    failedCallbacks: 1,
    isWeekday: true
  });
  assert.equal(w.length, 4);
  assert.equal(warnings({ stats: { creditExhausted: 0, outbound: 5 }, dialErrors: [], failedCallbacks: 0, isWeekday: true }).length, 0);
});

test("renderSummaryPage escapes text from calls", () => {
  const html = renderSummaryPage({
    hours: 24, generatedAt: new Date(0), stats: summarizeCalls([]), warningsList: [],
    demos: [{ name: "<b>x</b>", email: "a@b.com", start_utc: new Date(0) }],
    needsYou: [{ label: "Called us back", html: "safe", summary: "<script>" }],
    pendingCallbacks: 2, queuedRetries: 3, csvLink: "/reports/calls.csv?token=t"
  });
  assert.ok(html.includes("&lt;b&gt;x&lt;/b&gt;"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
});
