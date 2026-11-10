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
  const candidates = [];
  const view = availabilityView || "";
  for (let i = 0; i < view.length; i++) {
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
    candidates.push({ slot, minutes });
  }

  const toResult = c => ({ start: c.slot.toISOString(), label: formatSlot(c.slot, timeZone) });

  if (!distinctDays) return candidates.slice(0, count).map(toResult);

  // One slot per day, alternating morning and afternoon so the prospect gets
  // a real choice ("Tuesday morning or Wednesday afternoon").
  const byDay = new Map();
  for (const c of candidates) {
    const day = localDate(c.slot, timeZone);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(c);
  }
  const picks = [];
  for (const daySlots of byDay.values()) {
    if (picks.length >= count) break;
    const wantAfternoon = picks.length % 2 === 1;
    const choice = wantAfternoon
      ? daySlots.find(c => c.minutes >= 13 * 60) || daySlots[0]
      : daySlots.find(c => c.minutes < 12 * 60) || daySlots[0];
    picks.push(choice);
  }
  return picks.map(toResult);
}

// Slots around a target time, for when the prospect names a day or a time.
//   mode "near":   free times on the target's day, closest to the target first
//                  ("4 PM is taken; 3:30 or 4:30?")
//   mode "spread": the first free morning and first free afternoon that day
// If the day has fewer than `count`, the rest come from the following days.
function pickAround({ target, mode = "near", count = 2, ...options }) {
  const all = pickFreeSlots({ ...options, count: Infinity });
  const targetDay = localDate(target, options.timeZone);
  const sameDay = all.filter(s => localDate(new Date(s.start), options.timeZone) === targetDay);
  const minutesOf = s => localParts(new Date(s.start), options.timeZone).minutes;

  let picks;
  if (mode === "spread") {
    const morning = sameDay.find(s => minutesOf(s) < 12 * 60);
    const afternoon = sameDay.find(s => minutesOf(s) >= 13 * 60);
    picks = [morning, afternoon].filter(Boolean);
    if (picks.length === 0) picks = sameDay.slice(0, 1);
  } else {
    const t = target.getTime();
    picks = [...sameDay]
      .sort((a, b) => Math.abs(new Date(a.start) - t) - Math.abs(new Date(b.start) - t))
      .slice(0, count)
      .sort((a, b) => new Date(a.start) - new Date(b.start));
  }
  picks = picks.slice(0, count);

  if (picks.length < count) {
    const later = pickFreeSlots({ ...options, count: Infinity, distinctDays: true })
      .filter(s => localDate(new Date(s.start), options.timeZone) > targetDay);
    picks = picks.concat(later.slice(0, count - picks.length));
  }
  return picks;
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

module.exports = {
  pickAround, pickFreeSlots, combineAvailability, formatSlot, isPlausibleEmail };
