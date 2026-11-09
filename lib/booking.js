"use strict";

const { localParts } = require("./callingWindow");

// Microsoft Graph getSchedule returns an "availabilityView" string where each
// character is one interval: 0 free, 1 tentative, 2 busy, 3 out of office,
// 4 working elsewhere. Pick the first `count` free slots that are
//   - at or after `earliest`,
//   - on a weekday and inside demo hours in the prospect's time zone.
function pickFreeSlots({
  availabilityView,
  windowStart,          // Date: start of the getSchedule window
  intervalMinutes = 30,
  timeZone,             // prospect's IANA zone
  earliest,             // Date
  startHour = 9,
  endHour = 17,
  count = 3,
  distinctDays = false  // true: at most one slot per local day
}) {
  const slots = [];
  const usedDays = new Set();
  const view = availabilityView || "";
  for (let i = 0; i < view.length && slots.length < count; i++) {
    if (view[i] !== "0") continue;
    const slot = new Date(windowStart.getTime() + i * intervalMinutes * 60 * 1000);
    if (slot < earliest) continue;
    const { weekday, minutes } = localParts(slot, timeZone);
    if (weekday === "Sat" || weekday === "Sun") continue;
    if (minutes < startHour * 60 || minutes + intervalMinutes > endHour * 60) continue;
    if (distinctDays) {
      const day = localDate(slot, timeZone);
      if (usedDays.has(day)) continue;
      usedDays.add(day);
    }
    slots.push({ start: slot.toISOString(), label: formatSlot(slot, timeZone) });
  }
  return slots;
}

function localDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatSlot(date, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function isPlausibleEmail(email) {
  return typeof email === "string" && EMAIL_RE.test(email.trim());
}

module.exports = { pickFreeSlots, formatSlot, isPlausibleEmail };
