"use strict";

const { resolveTimeZone } = require("./timezones");
const { isValidTimeZone } = require("./callingWindow");

// Lead details that came in with the original call (campaign CSV columns).
// Follow-up calls carry them so Sarah has the same context the second time.
const LEAD_KEYS = ["prospect_name", "title", "company", "industry", "email", "city", "state", "country"];

function leadVariables(dynamicVariables) {
  const out = {};
  if (!dynamicVariables || typeof dynamicVariables !== "object") return out;
  for (const key of LEAD_KEYS) {
    const value = dynamicVariables[key];
    if (typeof value === "string" && value.trim() && !value.includes("{{")) out[key] = value.trim();
  }
  return out;
}

// The prospect's own time zone, if the lead's location pins it down.
function leadTimeZone(vars) {
  if (!vars) return null;
  const result = resolveTimeZone({ city: vars.city, state: vars.state, country: vars.country });
  const tz = result.time_zone || result.likely_time_zone;
  return isValidTimeZone(tz) ? tz : null;
}

// Automatic follow-ups run 9 AM to 5 PM on weekdays in the prospect's own
// time zone. Without a known zone, fall back to the shared window.
function followUpWindow(timeZone, fallback) {
  if (isValidTimeZone(timeZone)) return { timeZone, startHour: 9, endHour: 17, weekdaysOnly: true };
  return fallback;
}

// Phone trees and dead numbers never improve with another try.
const NEVER_RETRY = new Set(["invalid_destination", "ivr_reached"]);
// The phone rang but nobody (or a busy line) answered.
const NO_ANSWER = new Set(["dial_no_answer", "dial_busy", "dial_failed", "inactivity"]);
// A person saw or answered the call and ended it without a real conversation.
const PERSON_ENDED = new Set(["user_hangup", "user_declined"]);

// Decide whether an ORIGINAL call (campaign or callback) gets an automatic
// follow-up, and of which kind.
//   standard   no answer / busy: +2 hours, then +1 day
//   voicemail  +1 day, then +3 days
//   hung_up    the person picked up or declined and ended it: one try, 3 days later
//   demo_recovery  agreed to a demo but the booking did not finish
function retryPlan({ disconnectReason, inVoicemail, prospectOutcome, automaticRetryAllowed, demoIntentIncomplete }) {
  if (demoIntentIncomplete) return { retry: true, type: "demo_recovery" };
  if (NEVER_RETRY.has(disconnectReason)) return { retry: false, reason: disconnectReason };

  const meaningful = Boolean(prospectOutcome) && prospectOutcome !== "no_meaningful_conversation";
  if (meaningful) return { retry: false, reason: "conversation" };

  if (inVoicemail || disconnectReason === "voicemail_reached") return { retry: true, type: "voicemail" };
  if (PERSON_ENDED.has(disconnectReason)) return { retry: true, type: "hung_up" };
  if (NO_ANSWER.has(disconnectReason)) return { retry: true, type: "standard" };
  if (automaticRetryAllowed) return { retry: true, type: "standard" };
  return { retry: false, reason: disconnectReason || "unknown" };
}

// For a call placed BY a retry chain: should the chain try again?
// Once a person has picked up and ended the call, or the number turns out to
// be a phone tree or dead, the chain stops.
function continueChain(plan) {
  return plan.retry && (plan.type === "standard" || plan.type === "voicemail");
}

const HOUR = 60 * 60 * 1000;

function firstDelayMs(type) {
  if (type === "demo_recovery") return 60 * 1000;
  if (type === "voicemail") return 24 * HOUR;
  if (type === "hung_up") return 72 * HOUR;
  return 2 * HOUR;
}

// Delay before the next try after `retryCount` tries, or null when done.
function nextDelayMs(type, retryCount) {
  if (type === "voicemail") return { 0: 24 * HOUR, 1: 72 * HOUR }[retryCount] ?? null;
  if (type === "standard") return retryCount < 2 ? 24 * HOUR : null;
  return null; // hung_up and demo_recovery get a single try
}

function retryContext(type) {
  if (type === "demo_recovery") {
    return "The prospect already agreed to a demo, but the previous call disconnected before the booking was completed. Resume the demo booking immediately.";
  }
  if (type === "hung_up") {
    return "A previous call reached this person but ended within seconds, before any real conversation. Keep the opening very short and get to the reason for the call quickly.";
  }
  return "This is an automatic follow-up attempt because the previous outbound call did not connect with the prospect.";
}

module.exports = {
  LEAD_KEYS,
  leadVariables,
  leadTimeZone,
  followUpWindow,
  retryPlan,
  continueChain,
  firstDelayMs,
  nextDelayMs,
  retryContext
};
