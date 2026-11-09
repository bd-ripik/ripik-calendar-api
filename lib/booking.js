"use strict";

const { localParts, inWindow } = require("./callingWindow");

// Merge several getSchedule availabilityView strings: an interval is free
// ("0") only if it is free for everyone.
function combineAvailability(views) {
  const list = (views || []).filter(v => typeof v === "string");
  if (list.length === 0) return "";
  const length = Math.min(...list.map(v => v.length));
  let out = "";
  for (let i = 0; i < length; i++) {
    out += list.every(v => v[i] === "0") ? "0" : "2";
  }
  return out;
}

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
  distinctDays = false, // true: at most one slot per local day
  teamWindow = null     // optional { timeZone, startHour, endHour }: the demo team's own hours
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
    if (teamWindow) {
      const spec = { ...teamWindow, weekdaysOnly: true };
      const slotEnd = new Date(slot.getTime() + (intervalMinutes - 1) * 60 * 1000);
      if (!inWindow(slot, spec) || !inWindow(slotEnd, spec)) continue;
    }
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

module.exports = { pickFreeSlots, combineAvailability, formatSlot, isPlausibleEmail };
