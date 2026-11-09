"use strict";

// Decides WHEN the backend is allowed to dial. Two rules:
//
// 1. Automatic retries (nobody asked us to call): weekdays only, inside a
//    business window defined in one reference time zone. The default,
//    11:00-17:00 America/New_York, is 8:00-14:00 Pacific and 10:00-16:00
//    Central, so it is business hours everywhere in the continental US.
//
// 2. Requested callbacks (the prospect asked for this time): honoured on any
//    day, but never outside 08:00-21:00 in the prospect's own time zone. If
//    the time zone is unknown we use 11:00-21:00 Eastern, which is inside
//    08:00-21:00 for every continental US zone.

const DAY_MS = 24 * 60 * 60 * 1000;
const STEP_MS = 5 * 60 * 1000;

function isValidTimeZone(tz) {
  if (!tz || typeof tz !== "string") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Local wall-clock parts of `date` in `timeZone`.
function localParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map(p => [p.type, p.value]));
  return {
    weekday: parts.weekday, // "Mon".."Sun"
    minutes: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function inWindow(date, { timeZone, startHour, endHour, weekdaysOnly }) {
  const { weekday, minutes } = localParts(date, timeZone);
  if (weekdaysOnly && (weekday === "Sat" || weekday === "Sun")) return false;
  return minutes >= startHour * 60 && minutes < endHour * 60;
}

// First moment >= `date` that is inside the window (searches up to 8 days).
function nextInWindow(date, windowSpec) {
  if (inWindow(date, windowSpec)) return new Date(date.getTime());
  // Align to the next 5-minute boundary, then walk forward.
  let t = Math.ceil(date.getTime() / STEP_MS) * STEP_MS;
  const limit = date.getTime() + 8 * DAY_MS;
  while (t <= limit) {
    if (inWindow(new Date(t), windowSpec)) return new Date(t);
    t += STEP_MS;
  }
  return null;
}

function retryWindowFromEnv(env = process.env) {
  return {
    timeZone: env.RETRY_WINDOW_TZ || "America/New_York",
    startHour: Number(env.RETRY_WINDOW_START_HOUR ?? 11),
    endHour: Number(env.RETRY_WINDOW_END_HOUR ?? 17),
    weekdaysOnly: true
  };
}

function callbackWindowFor(timeZone) {
  if (isValidTimeZone(timeZone) && timeZone !== "UTC" && timeZone !== "Etc/UTC") {
    return { timeZone, startHour: 8, endHour: 21, weekdaysOnly: false };
  }
  return { timeZone: "America/New_York", startHour: 11, endHour: 21, weekdaysOnly: false };
}

module.exports = {
  isValidTimeZone,
  localParts,
  inWindow,
  nextInWindow,
  retryWindowFromEnv,
  callbackWindowFor
};
