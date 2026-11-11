require("dotenv").config();
require("isomorphic-fetch");

const express = require("express");
const { Pool } = require("pg");
const { DateTime } = require("luxon");
const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");

const { normalizePhone } = require("./lib/phone");
const { verifyRetellSignature } = require("./lib/retellSignature");
const {
  isValidTimeZone,
  inWindow,
  nextInWindow,
  retryWindowFromEnv,
  callbackWindowFor
} = require("./lib/callingWindow");
const { resolveTimeZone } = require("./lib/timezones");
const { parseCallbackTime, leadVariables, leadTimeZone, followUpWindow, retryPlan, continueChain, firstDelayMs, nextDelayMs: nextRetryDelayMs, retryContext } = require("./lib/followUp");
const { pickFreeSlots, pickAround, combineAvailability, isPlausibleEmail, formatSlot } = require("./lib/booking");

// =========================================================
// Configuration
// =========================================================

const CONFIG = {
  // Master switch. Nothing is dialled by the backend unless this is "true".
  dialingEnabled: process.env.DIALING_ENABLED === "true",
  // Reject any request that is not signed by Retell. Only set to "false" for
  // local testing.
  requireSignature: process.env.REQUIRE_RETELL_SIGNATURE !== "false",
  // Automatic retries are skipped once a number has had this many calls in
  // the last 7 days (all sources, including Retell batch calls).
  maxCallsPerNumber7d: Number(process.env.MAX_CALLS_PER_NUMBER_7D || 3),
  // Demo slots offered when the requested time is busy (prospect local time).
  demoHoursStart: Number(process.env.DEMO_HOURS_START || 9),
  demoHoursEnd: Number(process.env.DEMO_HOURS_END || 19),
  // Earliest a demo can be offered, in hours from now.
  demoMinNoticeHours: Number(process.env.DEMO_MIN_NOTICE_HOURS || 3),
  // Optional: the demo team's own working hours. Only applied when
  // DEMO_TEAM_TZ is set; offered slots must then fit both windows.
  demoTeamWindow: process.env.DEMO_TEAM_TZ
    ? {
        timeZone: process.env.DEMO_TEAM_TZ,
        startHour: Number(process.env.DEMO_TEAM_START_HOUR || 8),
        endHour: Number(process.env.DEMO_TEAM_END_HOUR || 17)
      }
    : null,
  // People copied on every demo invite (for example to forward it on).
  // Their calendars are NOT checked.
  demoNotify: (process.env.DEMO_NOTIFY_EMAILS || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  // Internal people added to every demo invite. Their calendars are also
  // checked: a slot is offered only if the BD mailbox and all of them are free.
  demoAttendees: (process.env.DEMO_ATTENDEES || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),
  retryWindow: retryWindowFromEnv()
};

const app = express();

// Keep the exact request body so Retell signatures can be verified.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    }
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID,
  process.env.AZURE_CLIENT_ID,
  process.env.AZURE_CLIENT_SECRET
);

const graphClient = Client.initWithMiddleware({
  authProvider: {
    getAccessToken: async () => {
      const token = await credential.getToken("https://graph.microsoft.com/.default");
      return token.token;
    }
  }
});

const BD_MAILBOX = process.env.USER_EMAIL;

// =========================================================
// Request helpers
// =========================================================

function requireRetell(req, res, next) {
  if (!CONFIG.requireSignature) return next();

  const ok = verifyRetellSignature(
    req.rawBody || "",
    process.env.RETELL_API_KEY,
    req.get("x-retell-signature")
  );

  if (!ok) {
    console.warn("REJECTED UNSIGNED REQUEST:", req.method, req.path);
    return res.status(401).json({ success: false, error: "Invalid signature" });
  }
  next();
}

// Retell tools can send either the bare arguments ("Payload: args only") or
// { name, args, call }. Accept both.
function toolArgs(req) {
  const body = req.body || {};
  if (body.args && typeof body.args === "object") return body.args;
  return body;
}

// The prospect's number, taken from the call itself when Retell includes the
// call object. This is more reliable than an LLM-filled phone argument.
function callPhone(req) {
  const call = req.body && req.body.call;
  if (!call) return null;
  if (call.direction && call.direction !== "outbound") return normalizePhone(call.from_number);
  return normalizePhone(call.to_number);
}

// Tool responses use HTTP 200 with success:false for business outcomes so the
// agent always receives the message; 5xx is reserved for unexpected errors.
function toolFailure(res, message, extra = {}) {
  return res.status(200).json({ success: false, error: message, ...extra });
}

// =========================================================
// Basic endpoints
// =========================================================

app.get("/", (_req, res) => {
  res.send("API is running");
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, dialing_enabled: CONFIG.dialingEnabled });
});

// =========================================================
// Time and time zone tools
// =========================================================

function currentTimeHandler(req, res) {
  const requested = (req.query && req.query.timeZone) || toolArgs(req).timeZone || "UTC";
  const timeZone = isValidTimeZone(requested) ? requested : "UTC";
  const now = DateTime.now().setZone(timeZone);

  res.json({
    currentDate: now.toFormat("yyyy-MM-dd"),
    currentTime: now.toFormat("HH:mm:ss"),
    currentDayOfWeek: now.toFormat("cccc"),
    currentDateTime: now.toISO({ suppressMilliseconds: true }),
    timeZone,
    ...(timeZone !== requested ? { note: `Unknown time zone "${requested}", used UTC.` } : {})
  });
}

app.get("/current-time", requireRetell, currentTimeHandler);
app.post("/current-time", requireRetell, currentTimeHandler);

app.post("/resolve-timezone", requireRetell, (req, res) => {
  const { city, state, country } = toolArgs(req);
  const result = resolveTimeZone({ city, state, country });
  console.log("RESOLVE TIMEZONE:", { city, state, country, result: result.time_zone });
  res.json(result);
});

// =========================================================
// Demo booking (Microsoft Graph)
// =========================================================

// Free/busy for the BD mailbox plus every internal demo attendee.
async function getAvailability(startDT, endDT, timeZone, intervalMinutes = 30) {
  const schedules = [BD_MAILBOX, ...CONFIG.demoAttendees.filter(e => e !== BD_MAILBOX.toLowerCase())];
  const schedule = await graphClient
    .api(`/users/${BD_MAILBOX}/calendar/getSchedule`)
    .post({
      schedules,
      startTime: { dateTime: startDT.setZone(timeZone).toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone },
      endTime: { dateTime: endDT.setZone(timeZone).toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone },
      availabilityViewInterval: intervalMinutes
    });

  const value = schedule.value || [];
  const failed = value.filter(v => v.error);
  if (failed.length) {
    // An unreadable calendar must not look "free".
    throw new Error(`Could not read calendar(s): ${failed.map(v => v.scheduleId).join(", ")}`);
  }
  return {
    availabilityView: combineAvailability(value.map(v => v.availabilityView)),
    scheduleItems: value.flatMap(v => v.scheduleItems || [])
  };
}

// Returns a short reason if the time breaks the demo rules, otherwise null.
function demoRuleProblem(startDT) {
  const weekday = startDT.weekday; // 1 = Monday ... 7 = Sunday
  const minutes = startDT.hour * 60 + startDT.minute;
  if (weekday >= 6) return "Demos only run on weekdays.";
  if (minutes < CONFIG.demoHoursStart * 60 || minutes + 30 > CONFIG.demoHoursEnd * 60) {
    return `Demos run between ${formatHour(CONFIG.demoHoursStart)} and ${formatHour(CONFIG.demoHoursEnd)} the prospect's time.`;
  }
  if (startDT < DateTime.now().plus({ hours: CONFIG.demoMinNoticeHours })) {
    return `Demos need at least ${CONFIG.demoMinNoticeHours} hours' notice.`;
  }
  return null;
}

function formatHour(h) {
  const suffix = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12} ${suffix}`;
}

async function isSlotBusy(startDT, timeZone) {
  const info = await getAvailability(startDT, startDT.plus({ minutes: 30 }), timeZone);
  const items = info.scheduleItems.filter(item => item.status !== "free");
  if (items.length > 0) return true;
  if (!CONFIG.demoTeamWindow) return false;
  // Outside the demo team's working hours counts as busy.
  const start = startDT.toJSDate();
  const lastMinute = startDT.plus({ minutes: 29 }).toJSDate();
  const team = { ...CONFIG.demoTeamWindow, weekdaysOnly: true };
  return !inWindow(start, team) || !inWindow(lastMinute, team);
}

// Free 30-minute slots on weekdays inside demo hours, from `fromDT` and
// looking `days` ahead. Never sooner than the minimum notice.
async function suggestSlots(fromDT, timeZone, { distinctDays = false, count = 3, days = 5 } = {}) {
  const earliest = DateTime.now().plus({ hours: CONFIG.demoMinNoticeHours });
  const windowStart = DateTime.max(fromDT.setZone(timeZone).startOf("day"), earliest.setZone(timeZone).startOf("hour"));
  const windowEnd = windowStart.plus({ days });

  const info = await getAvailability(windowStart, windowEnd, timeZone, 30);

  return pickFreeSlots({
    availabilityView: info.availabilityView,
    windowStart: windowStart.toJSDate(),
    intervalMinutes: 30,
    timeZone,
    earliest: earliest.toJSDate(),
    startHour: CONFIG.demoHoursStart,
    endHour: CONFIG.demoHoursEnd,
    count,
    distinctDays,
    teamWindow: CONFIG.demoTeamWindow
  });
}

// Free slots around a time or day the prospect named (see pickAround).
async function slotsAround(targetDT, timeZone, { mode = "near", count = 2 } = {}) {
  const earliest = DateTime.now().plus({ hours: CONFIG.demoMinNoticeHours });
  const base = targetDT < earliest ? earliest : targetDT;
  const windowStart = DateTime.max(base.setZone(timeZone).startOf("day"), earliest.setZone(timeZone).startOf("hour"));
  const info = await getAvailability(windowStart, windowStart.plus({ days: 7 }), timeZone, 30);

  return pickAround({
    target: targetDT.toJSDate(),
    mode,
    count,
    availabilityView: info.availabilityView,
    windowStart: windowStart.toJSDate(),
    intervalMinutes: 30,
    timeZone,
    earliest: earliest.toJSDate(),
    startHour: CONFIG.demoHoursStart,
    endHour: CONFIG.demoHoursEnd,
    teamWindow: CONFIG.demoTeamWindow
  });
}

// Tool: Get_Demo_Slots. Gives Ava concrete free times to offer, one per day,
// so the prospect only has to pick. Each slot's "start" can be passed straight
// to Book_Demo_Meeting.
app.post("/demo-slots", requireRetell, async (req, res) => {
  try {
    const args = toolArgs(req);
    const timeZone = args.timeZone || args.time_zone;
    if (!isValidTimeZone(timeZone)) {
      return toolFailure(res, "The prospect's time zone is needed first. Resolve it or ask the prospect.");
    }

    // Optional preferred day (YYYY-MM-DD in the prospect's zone).
    // A specific time the prospect proposed ("Thursday at 4"): check that
    // exact time and say so, rather than only listing other times.
    const dateArg = args.date ? String(args.date) : "";
    const requested = args.requested_start || args.requestedStart || (/T\d/.test(dateArg) ? dateArg : "");
    if (requested) {
      const reqDT = DateTime.fromISO(String(requested), { zone: timeZone });
      if (reqDT.isValid) {
        let reason = demoRuleProblem(reqDT);
        if (!reason && !(await isSlotBusy(reqDT, timeZone))) {
          const slot = { start: reqDT.toUTC().toISO(), label: formatSlot(reqDT.toJSDate(), timeZone) };
          console.log("DEMO TIME REQUESTED:", { timeZone, requested: slot.label, available: true });
          return res.json({
            success: true,
            requested_available: true,
            message: "The requested time is free. Tell the prospect it works, confirm the email, then book it with this start value.",
            timeZone,
            slots: [slot]
          });
        }
        reason = reason || "That time is already taken on the team's calendar.";
        const slots = await slotsAround(reqDT, timeZone, { mode: "near", count: 2 });
        console.log("DEMO TIME REQUESTED:", { timeZone, requested: reqDT.toISO(), available: false, reason, offered: slots.map(s => s.label) });
        return res.json({
          success: true,
          requested_available: false,
          reason,
          message: `${reason} Tell the prospect briefly and offer these times instead.`,
          timeZone,
          slots
        });
      }
    }

    // A preferred day only ("Thursday", "Thursday afternoon"): a morning and
    // an afternoon time on that day.
    if (dateArg) {
      const dayDT = DateTime.fromISO(dateArg.slice(0, 10), { zone: timeZone });
      if (dayDT.isValid && dayDT.endOf("day") > DateTime.now()) {
        const slots = await slotsAround(dayDT, timeZone, { mode: "spread", count: 2 });
        console.log("DEMO SLOTS FOR DAY:", { timeZone, date: dateArg, slots: slots.map(s => s.label) });
        if (slots.length > 0) return res.json({ success: true, timeZone, slots });
      }
    }

    const fromDT = DateTime.now().setZone(timeZone);

    const slots = await suggestSlots(fromDT, timeZone, { distinctDays: true, count: 3, days: 7 });
    console.log("DEMO SLOTS OFFERED:", { timeZone, slots: slots.map(s => s.label) });

    if (slots.length === 0) {
      return toolFailure(res, "No free demo slots in the next week. Ask the prospect which day suits them.");
    }
    return res.json({ success: true, timeZone, slots });
  } catch (err) {
    console.error("Demo slots error:", err);
    return res.status(500).json({ success: false, error: "Could not load available times." });
  }
});

app.post("/book-demo", requireRetell, async (req, res) => {
  const args = toolArgs(req);
  const name = (args.name || "").toString().trim();
  const email = (args.email || "").toString().trim().toLowerCase();
  const timeZone = args.timeZone || args.time_zone;
  const start = args.start;
  const callId = req.body && req.body.call ? req.body.call.call_id : null;

  console.log("BOOK DEMO REQUEST:", { name, email, start, timeZone, callId });

  if (!isPlausibleEmail(email)) {
    return toolFailure(res, "The email address looks incomplete. Confirm the email with the prospect.");
  }
  if (!isValidTimeZone(timeZone)) {
    return toolFailure(res, "The time zone is missing or not recognised. Use an IANA zone such as America/New_York.");
  }

  const startDT = DateTime.fromISO(String(start || ""), { zone: timeZone });
  if (!startDT.isValid) {
    return toolFailure(res, "The meeting start time could not be understood. Use an ISO 8601 date and time.");
  }
  if (startDT < DateTime.now().plus({ minutes: 10 })) {
    return toolFailure(res, "That time is in the past or too soon. Ask the prospect for a later time.");
  }

  // Demos only run on weekdays inside demo hours (prospect's local time), with
  // enough notice for the team. Anything else gets nearby alternatives.
  const outsideRules = demoRuleProblem(startDT);
  if (outsideRules) {
    try {
      const suggestions = await slotsAround(startDT, timeZone, { mode: "near", count: 2 });
      return res.json({
        success: false,
        available: false,
        message: `${outsideRules} Offer the first suggestion instead.`,
        suggestions
      });
    } catch (err) {
      console.error("Suggestion error:", err);
      return toolFailure(res, `${outsideRules} Ask the prospect for another time.`);
    }
  }

  const startUtc = startDT.toUTC().toJSDate();
  let bookingId;

  try {
    // Idempotency: the same email + start time is only ever booked once, even
    // if Ava retries the tool after a timeout.
    const inserted = await pool.query(
      `INSERT INTO demo_bookings (email, name, start_utc, time_zone, status, call_id)
       VALUES ($1, $2, $3, $4, 'creating', $5)
       ON CONFLICT (email, start_utc) DO NOTHING
       RETURNING id`,
      [email, name || null, startUtc, timeZone, callId]
    );

    if (inserted.rows.length > 0) {
      bookingId = inserted.rows[0].id;
    } else {
      const existing = (
        await pool.query(`SELECT * FROM demo_bookings WHERE email = $1 AND start_utc = $2`, [email, startUtc])
      ).rows[0];

      if (existing.status === "booked") {
        return res.json({
          success: true,
          message: "Meeting booked successfully.",
          joinUrl: existing.join_url,
          eventId: existing.event_id,
          duplicate: true
        });
      }

      if (existing.status === "creating" && Date.now() - new Date(existing.updated_at).getTime() < 2 * 60 * 1000) {
        return toolFailure(res, "This booking is already being created. Wait a few seconds before checking again.", {
          in_progress: true
        });
      }

      await pool.query(
        `UPDATE demo_bookings SET status = 'creating', error = NULL, updated_at = NOW() WHERE id = $1`,
        [existing.id]
      );
      bookingId = existing.id;
    }

    if (await isSlotBusy(startDT, timeZone)) {
      await pool.query(`UPDATE demo_bookings SET status = 'slot_busy', updated_at = NOW() WHERE id = $1`, [bookingId]);
      const suggestions = await slotsAround(startDT, timeZone, { mode: "near", count: 2 });
      return res.json({
        success: false,
        available: false,
        message: suggestions.length
          ? "That time is not available. Offer the first suggestion."
          : "That time is not available and no nearby free slots were found. Ask for another day.",
        suggestions
      });
    }

    const endDT = startDT.plus({ minutes: 30 });
    const event = {
      subject: `Ripik <> ${name || email} - Vision AI Demo Walkthrough`,
      body: {
        contentType: "HTML",
        content: `Demo booked by Ripik AI.<br><br>Name: ${escapeHtml(name)}<br>Email: ${escapeHtml(email)}`
      },
      start: { dateTime: startDT.toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone },
      end: { dateTime: endDT.toFormat("yyyy-MM-dd'T'HH:mm:ss"), timeZone },
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      // Graph uses transactionId to avoid creating the same event twice.
      transactionId: `ripik-demo-${bookingId}`,
      attendees: [
        { emailAddress: { address: email, name: name || email }, type: "required" },
        ...CONFIG.demoAttendees
          .filter(a => a !== email && a !== BD_MAILBOX.toLowerCase())
          .map(address => ({ emailAddress: { address }, type: "required" })),
        ...CONFIG.demoNotify
          .filter(a => a !== email && a !== BD_MAILBOX.toLowerCase() && !CONFIG.demoAttendees.includes(a))
          .map(address => ({ emailAddress: { address }, type: "optional" }))
      ]
    };

    const result = await graphClient
      .api(`/users/${BD_MAILBOX}/calendar/events`)
      .header("Prefer", `outlook.timezone="${timeZone}"`)
      .post(event);

    const joinUrl = result.onlineMeeting ? result.onlineMeeting.joinUrl : null;

    await pool.query(
      `UPDATE demo_bookings SET status = 'booked', event_id = $1, join_url = $2, updated_at = NOW() WHERE id = $3`,
      [result.id, joinUrl, bookingId]
    );

    console.log("DEMO BOOKED:", { bookingId, email, start: startDT.toISO() });

    return res.json({ success: true, message: "Meeting booked successfully.", joinUrl, eventId: result.id });
  } catch (err) {
    console.error("Booking error:", err);
    if (bookingId) {
      await pool
        .query(`UPDATE demo_bookings SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`, [
          String(err.message || err).slice(0, 500),
          bookingId
        ])
        .catch(() => {});
    }
    return res.status(500).json({ success: false, error: "Scheduling system error. The meeting was not booked." });
  }
});

app.post("/check-availability", requireRetell, async (req, res) => {
  try {
    const { start, timeZone } = toolArgs(req);
    if (!isValidTimeZone(timeZone)) return toolFailure(res, "Unknown time zone.");
    const startDT = DateTime.fromISO(String(start || ""), { zone: timeZone });
    if (!startDT.isValid) return toolFailure(res, "Start time could not be understood.");

    const busy = await isSlotBusy(startDT, timeZone);
    res.json({ success: true, available: !busy });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: "Availability check failed." });
  }
});

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}

// =========================================================
// DND
// =========================================================

async function isDnd(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  const result = await pool.query(`SELECT 1 FROM dnd_numbers WHERE phone = $1 LIMIT 1`, [normalized]);
  return result.rows.length > 0;
}

async function addToDnd(phone, reason) {
  await pool.query(
    `INSERT INTO dnd_numbers (phone, reason) VALUES ($1, $2)
     ON CONFLICT (phone) DO UPDATE SET reason = EXCLUDED.reason`,
    [phone, reason]
  );
  await pool.query(
    `UPDATE callbacks SET status = 'cancelled', updated_at = NOW()
     WHERE phone = $1 AND status IN ('pending', 'dialing')`,
    [phone]
  );
  await pool.query(
    `UPDATE call_retries SET status = 'cancelled', next_retry_time = NULL, updated_at = NOW()
     WHERE phone = $1 AND status IN ('pending', 'processing', 'waiting_result', 'paused')`,
    [phone]
  );
}

app.post("/add-dnd", requireRetell, async (req, res) => {
  try {
    const args = toolArgs(req);
    const phone = normalizePhone(args.phone) || callPhone(req);

    if (!phone) {
      console.error("DND REJECTED - NO VALID PHONE:", { received_phone: args.phone });
      return toolFailure(res, "Could not identify the phone number to remove.");
    }

    await addToDnd(phone, args.reason || "Prospect requested do not call");
    console.log("DND ADDED:", phone);

    return res.json({
      success: true,
      message: "Phone number added to DND and pending calls cancelled",
      phone
    });
  } catch (err) {
    console.error("DND error:", err);
    return res.status(500).json({ success: false, error: "Could not update the do-not-call list." });
  }
});

// =========================================================
// Requested callbacks
// =========================================================

app.post("/schedule-callback", requireRetell, async (req, res) => {
  try {
    const args = toolArgs(req);
    const phone = normalizePhone(args.phone) || callPhone(req);
    const name = args.name || null;
    const timeZone = isValidTimeZone(args.time_zone) ? args.time_zone : "UTC";
    const callbackTime = parseCallbackTime(args.callback_time, timeZone);

    if (!phone) {
      console.error("CALLBACK REJECTED - NO VALID PHONE:", { received_phone: args.phone });
      return toolFailure(res, "Could not identify the phone number for the callback.");
    }
    if (!callbackTime) {
      return toolFailure(res, "Callback time could not be understood. Use an ISO 8601 date and time.");
    }
    if (callbackTime.getTime() < Date.now() - 5 * 60 * 1000) {
      return toolFailure(res, "That callback time is in the past. Check the current time and try again.");
    }

    if (await isDnd(phone)) {
      console.log("CALLBACK BLOCKED BY DND:", phone);
      return res.json({ success: false, blocked: true, reason: "dnd", phone });
    }

    const result = await pool.query(
      `INSERT INTO callbacks (name, phone, callback_time, time_zone, status, lead_vars)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [name, phone, callbackTime, timeZone, JSON.stringify(leadVariables(req.body?.call?.retell_llm_dynamic_variables))]
    );

    console.log("CALLBACK SCHEDULED:", { id: result.rows[0].id, phone, callback_time: callbackTime, timeZone });

    return res.json({ success: true, message: "Callback scheduled", callback: result.rows[0] });
  } catch (err) {
    console.error("Callback scheduling error:", err);
    return res.status(500).json({ success: false, error: "Could not schedule the callback." });
  }
});

// =========================================================
// Placing calls
// =========================================================

// Every call the backend places goes through this function, so the same
// safety checks apply to callbacks, retries and demo recovery.
async function placeCall({ phone, name, purpose, retryType, variables }) {
  if (!CONFIG.dialingEnabled) return { blocked: true, reason: "dialing_disabled" };

  const to = normalizePhone(phone);
  if (!to) return { blocked: true, reason: "invalid_phone" };

  if (await isDnd(to)) return { blocked: true, reason: "dnd" };

  // Automatic retries respect a per-number cap and never chase someone who
  // already had a real conversation recently. Requested callbacks and demo
  // recovery are follow-ups the prospect agreed to, so they are exempt.
  if (purpose === "retry" && retryType !== "demo_recovery") {
    const { rows } = await pool.query(
      `SELECT
         count(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS recent_calls,
         count(*) FILTER (
           WHERE created_at > NOW() - INTERVAL '30 days'
             AND prospect_outcome IS NOT NULL
             AND prospect_outcome <> 'no_meaningful_conversation'
         ) AS conversations
       FROM call_log WHERE phone = $1`,
      [to]
    );
    if (Number(rows[0].conversations) > 0) return { blocked: true, reason: "already_spoke" };
    if (Number(rows[0].recent_calls) >= CONFIG.maxCallsPerNumber7d) return { blocked: true, reason: "attempt_cap" };
  }

  const response = await fetch("https://api.retellai.com/v2/create-phone-call", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RETELL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from_number: process.env.RETELL_FROM_NUMBER,
      to_number: to,
      retell_llm_dynamic_variables: {
        prospect_name: name || "",
        callback_phone: to,
        callback_context: "",
        retry_context: "",
        retry_type: "",
        ...variables
      }
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Retell call failed: ${JSON.stringify(data)}`);

  await pool.query(
    `INSERT INTO call_log (call_id, phone, source, retry_type)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (call_id) DO UPDATE SET source = EXCLUDED.source, retry_type = EXCLUDED.retry_type`,
    [data.call_id, to, purpose, retryType || null]
  );

  return data;
}

function retryVariables(retryType) {
  return { retry_type: retryType || "standard", retry_context: retryContext(retryType) };
}

// =========================================================
// Retell webhook
// =========================================================


async function recordCall(call) {
  if (!call || !call.call_id) return;
  const phone = normalizePhone(call.direction === "inbound" ? call.from_number : call.to_number);
  const analysis = call.call_analysis || {};
  const custom = analysis.custom_analysis_data || {};

  await pool.query(
    `INSERT INTO call_log
       (call_id, phone, disconnection_reason, duration_ms, prospect_outcome, in_voicemail, call_successful, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE(to_timestamp($8 / 1000.0), NOW()))
     ON CONFLICT (call_id) DO UPDATE SET
       phone = COALESCE(EXCLUDED.phone, call_log.phone),
       disconnection_reason = COALESCE(EXCLUDED.disconnection_reason, call_log.disconnection_reason),
       duration_ms = COALESCE(EXCLUDED.duration_ms, call_log.duration_ms),
       prospect_outcome = COALESCE(EXCLUDED.prospect_outcome, call_log.prospect_outcome),
       in_voicemail = COALESCE(EXCLUDED.in_voicemail, call_log.in_voicemail),
       call_successful = COALESCE(EXCLUDED.call_successful, call_log.call_successful),
       updated_at = NOW()`,
    [
      call.call_id,
      phone,
      call.disconnection_reason || null,
      Number.isFinite(call.duration_ms) ? call.duration_ms : null,
      custom.prospect_outcome || null,
      typeof analysis.in_voicemail === "boolean" ? analysis.in_voicemail : null,
      typeof analysis.call_successful === "boolean" ? analysis.call_successful : null,
      Number.isFinite(call.start_timestamp) ? call.start_timestamp : null
    ]
  );
}

app.post("/retell-webhook", requireRetell, async (req, res) => {
  try {
    const { event, call } = req.body || {};

    console.log("RETELL WEBHOOK EVENT:", event, {
      call_id: call?.call_id,
      disconnection_reason: call?.disconnection_reason,
      to_number: call?.to_number,
      duration_ms: call?.duration_ms,
      custom_analysis_data: call?.call_analysis?.custom_analysis_data
    });

    await recordCall(call);

    // Retry decisions happen only after analysis is complete.
    if (event !== "call_analyzed") {
      return res.status(200).json({ success: true, message: "Event received - no retry decision required" });
    }

    const callId = call?.call_id;
    const phone = normalizePhone(call?.to_number);
    const disconnectReason = call?.disconnection_reason;
    const analysis = call?.call_analysis;
    const customAnalysis = analysis?.custom_analysis_data;
    const prospectOutcome = customAnalysis?.prospect_outcome;

    const dndRequested =
      customAnalysis?.dnd_requested === true ||
      customAnalysis?.dnd_requested === "true" ||
      prospectOutcome === "do_not_call" ||
      prospectOutcome === "dnd";

    if (dndRequested && phone) {
      await addToDnd(phone, "Post-call analysis detected explicit DND request");
      console.log("POST-CALL DND ADDED:", phone);
      return res.status(200).json({ success: true, dnd_added: true, retry_scheduled: false });
    }

    if (!callId || !phone) {
      console.log("RETRY SKIPPED: Missing/invalid call ID or phone", { callId, to: call?.to_number });
      return res.status(200).json({ success: true, retry_scheduled: false, invalid_phone: true });
    }

    const inVoicemail = analysis?.in_voicemail === true;
    const automaticRetryAllowed = customAnalysis?.automatic_retry_allowed === true;
    const demoIntentIncomplete =
      customAnalysis?.demo_intent_incomplete === true || customAnalysis?.demo_intent_incomplete === "true";
    const name = call?.retell_llm_dynamic_variables?.prospect_name || null;

    // Which follow-up (if any) this call earns. See lib/followUp.js.
    const plan = retryPlan({ disconnectReason, inVoicemail, prospectOutcome, automaticRetryAllowed, demoIntentIncomplete });
    const shouldRetry = plan.retry;
    const leadVars = leadVariables(call?.retell_llm_dynamic_variables);

    // ---------------------------------------------------------
    // STEP A — Is this call already part of an existing retry chain?
    // ---------------------------------------------------------
    const existingRetryChain = await pool.query(
      `SELECT * FROM call_retries WHERE current_call_id = $1 LIMIT 1`,
      [callId]
    );

    if (existingRetryChain.rows.length > 0) {
      const retry = existingRetryChain.rows[0];
      const retryType = retry.retry_type || "standard";

      // Only a chain that is waiting for this call's result may act on it.
      // Anything else is a repeated webhook delivery or a chain that was
      // cancelled (DND) or parked in the meantime.
      if (retry.status !== "waiting_result") {
        console.log("RETRY RESULT IGNORED - CHAIN NOT WAITING:", { id: retry.id, status: retry.status });
        return res.status(200).json({ success: true, retry_scheduled: false, ignored: true });
      }

      // The prospect agreed to a demo on a retry call but the booking did not
      // finish: hand over to a fresh demo-recovery attempt.
      if (demoIntentIncomplete && retryType !== "demo_recovery") {
        await pool.query(
          `UPDATE call_retries SET status = 'completed', last_outcome = 'escalated_to_demo_recovery',
             next_retry_time = NULL, updated_at = NOW() WHERE id = $1`,
          [retry.id]
        );
        await insertRetryChain({ callId, phone, name, retryType: "demo_recovery", lastOutcome: "demo_booking_incomplete", leadVars });
        console.log("RETRY CHAIN ESCALATED TO DEMO RECOVERY:", retry.id);
        return res.status(200).json({ success: true, retry_scheduled: true, retry_type: "demo_recovery" });
      }

      if (!continueChain(plan)) {
        await pool.query(
          `UPDATE call_retries SET status = 'completed', last_outcome = $1, updated_at = NOW() WHERE id = $2`,
          [prospectOutcome || disconnectReason || "meaningful_conversation", retry.id]
        );
        console.log(`RETRY CHAIN COMPLETED: ${retry.id}`);
        return res.status(200).json({ success: true, retry_scheduled: false, retry_chain_completed: true });
      }

      const nextDelayMs = nextRetryDelayMs(retryType, retry.retry_count);

      if (!nextDelayMs) {
        const outcome =
          retryType === "demo_recovery"
            ? "demo_recovery_completed"
            : retryType === "voicemail"
              ? "voicemail_retry_exhausted"
              : prospectOutcome || disconnectReason || "retry_exhausted";
        await pool.query(
          `UPDATE call_retries SET status = 'exhausted', last_outcome = $1, next_retry_time = NULL,
             updated_at = NOW() WHERE id = $2`,
          [outcome, retry.id]
        );
        console.log("RETRY CHAIN EXHAUSTED:", { id: retry.id, retry_type: retryType, retry_count: retry.retry_count });
        return res.status(200).json({ success: true, retry_scheduled: false, retry_chain_exhausted: true });
      }

      const nextRetryTime = new Date(Date.now() + nextDelayMs);
      await pool.query(
        `UPDATE call_retries SET status = 'pending', next_retry_time = $1, last_outcome = $2, updated_at = NOW()
         WHERE id = $3`,
        [nextRetryTime, inVoicemail ? "voicemail" : prospectOutcome || disconnectReason || "retry_needed", retry.id]
      );
      console.log("NEXT AUTO RETRY QUEUED:", { id: retry.id, retry_type: retryType, next_retry_time: nextRetryTime });
      return res.status(200).json({
        success: true,
        retry_scheduled: true,
        retry_number: retry.retry_count + 1,
        retry_type: retryType,
        next_retry_time: nextRetryTime.toISOString()
      });
    }

    // ---------------------------------------------------------
    // STEP B — This is an ORIGINAL call (batch or callback), not a retry.
    // ---------------------------------------------------------
    if (!shouldRetry) {
      console.log(`RETRY SKIPPED: ${callId} | reason=${disconnectReason} | outcome=${prospectOutcome}`);
      return res.status(200).json({ success: true, retry_scheduled: false });
    }

    const existingOriginalRetry = await pool.query(
      `SELECT id FROM call_retries WHERE original_call_id = $1 LIMIT 1`,
      [callId]
    );
    if (existingOriginalRetry.rows.length > 0) {
      return res.status(200).json({ success: true, retry_scheduled: false, duplicate: true });
    }

    if (await isDnd(phone)) {
      return res.status(200).json({ success: true, retry_scheduled: false, blocked_by_dnd: true });
    }

    const retryType = plan.type;

    // One active chain per phone — except a demo recovery, which replaces it.
    const activeChain = await pool.query(
      `SELECT id FROM call_retries
       WHERE phone = $1 AND status IN ('pending', 'processing', 'waiting_result', 'paused')
       ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    if (activeChain.rows.length > 0) {
      if (retryType !== "demo_recovery") {
        console.log("RETRY SKIPPED - ACTIVE PHONE CHAIN EXISTS:", { phone, existing_retry_id: activeChain.rows[0].id });
        return res.status(200).json({ success: true, retry_scheduled: false, duplicate_phone_retry: true });
      }
      await pool.query(
        `UPDATE call_retries SET status = 'completed', last_outcome = 'superseded_by_demo_recovery',
           next_retry_time = NULL, updated_at = NOW()
         WHERE phone = $1 AND status IN ('pending', 'processing', 'waiting_result', 'paused')`,
        [phone]
      );
    }

    const lastOutcome =
      retryType === "demo_recovery"
        ? "demo_booking_incomplete"
        : inVoicemail
          ? "voicemail"
          : prospectOutcome || disconnectReason || "unknown";

    const nextRetryTime = await insertRetryChain({ callId, phone, name, retryType, lastOutcome, leadVars });

    console.log(`AUTO RETRY QUEUED: ${phone} (${retryType}) at ${nextRetryTime.toISOString()}`);
    return res.status(200).json({
      success: true,
      retry_scheduled: true,
      retry_number: 1,
      retry_type: retryType,
      next_retry_time: nextRetryTime.toISOString()
    });
  } catch (err) {
    console.error("Retell webhook error:", err);
    return res.status(500).json({ success: false, error: "Webhook processing failed" });
  }
});

async function insertRetryChain({ callId, phone, name, retryType, lastOutcome, leadVars = {} }) {
  const nextRetryTime = new Date(Date.now() + firstDelayMs(retryType));
  const timeZone = leadTimeZone(leadVars);

  await pool.query(
    `INSERT INTO call_retries
       (original_call_id, phone, name, retry_count, next_retry_time, status, last_outcome, retry_type, lead_vars, time_zone)
     VALUES ($1, $2, $3, 0, $4, 'pending', $5, $6, $7, $8)`,
    [callId, phone, name || leadVars.prospect_name || null, nextRetryTime, lastOutcome, retryType, JSON.stringify(leadVars), timeZone]
  );
  return nextRetryTime;
}

// =========================================================
// Workers
// =========================================================

let callbackWorkerBusy = false;
let retryWorkerBusy = false;

async function processDueCallbacks() {
  if (!CONFIG.dialingEnabled || callbackWorkerBusy) return;
  callbackWorkerBusy = true;

  try {
    // A callback stuck in "dialing" means the worker died mid-call. Never
    // redial automatically; leave it for manual review.
    await pool.query(
      `UPDATE callbacks SET status = 'failed', updated_at = NOW()
       WHERE status = 'dialing' AND updated_at < NOW() - INTERVAL '15 minutes'`
    );

    // Claim due callbacks atomically so no two workers can dial the same one.
    const { rows } = await pool.query(
      `UPDATE callbacks SET status = 'dialing', updated_at = NOW()
       WHERE id IN (
         SELECT id FROM callbacks
         WHERE status = 'pending' AND callback_time <= NOW()
         ORDER BY callback_time ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    );

    for (const callback of rows) {
      const window = callbackWindowFor(callback.time_zone);
      const now = new Date();
      // "Call me in 10 minutes" was asked for live on the phone, so a
      // short-notice callback (within 4 hours of the request) goes out on time.
      const shortNotice =
        callback.created_at &&
        new Date(callback.callback_time) - new Date(callback.created_at) <= 4 * 60 * 60 * 1000;

      if (!shortNotice && !inWindow(now, window)) {
        const next = nextInWindow(now, window);
        await pool.query(
          `UPDATE callbacks SET status = $1, callback_time = COALESCE($2, callback_time), updated_at = NOW() WHERE id = $3`,
          [next ? "pending" : "failed", next, callback.id]
        );
        console.log("CALLBACK OUTSIDE CALLING HOURS - MOVED:", { id: callback.id, next });
        continue;
      }

      try {
        const result = await placeCall({
          phone: callback.phone,
          name: callback.name,
          purpose: "callback",
          variables: { ...(callback.lead_vars || {}), callback_context: "The prospect previously asked to be called back." }
        });

        if (result.blocked) {
          await pool.query(
            `UPDATE callbacks SET status = $1, updated_at = NOW() WHERE id = $2`,
            [result.reason === "dialing_disabled" ? "pending" : "cancelled", callback.id]
          );
          console.log("CALLBACK NOT PLACED:", { id: callback.id, reason: result.reason });
          continue;
        }

        await pool.query(
          `UPDATE callbacks SET status = 'completed', call_id = $1, updated_at = NOW() WHERE id = $2`,
          [result.call_id, callback.id]
        );
        console.log("CALLBACK PLACED:", { id: callback.id, call_id: result.call_id });
      } catch (err) {
        console.error(`Callback failed for ID ${callback.id}:`, err.message);
        await pool.query(`UPDATE callbacks SET status = 'failed', updated_at = NOW() WHERE id = $1`, [callback.id]);
        console.log(`CALLBACK MARKED FAILED - MANUAL REVIEW REQUIRED: ${callback.id}`);
      }
    }
  } catch (err) {
    console.error("Callback worker error:", err);
  } finally {
    callbackWorkerBusy = false;
  }
}

async function processDueRetries() {
  if (!CONFIG.dialingEnabled || retryWorkerBusy) return;
  retryWorkerBusy = true;

  try {
    // Release claims left behind by a crash before a call was placed.
    await pool.query(
      `UPDATE call_retries SET status = 'pending', updated_at = NOW()
       WHERE status = 'processing' AND current_call_id IS NULL AND updated_at < NOW() - INTERVAL '15 minutes'`
    );

    const { rows } = await pool.query(
      `UPDATE call_retries SET status = 'processing', updated_at = NOW()
       WHERE id IN (
         SELECT id FROM call_retries
         WHERE status = 'pending'
           AND next_retry_time <= NOW()
           AND (
             (retry_type = 'demo_recovery' AND retry_count < 1)
             OR (retry_type = 'voicemail' AND retry_count < 2)
             OR (COALESCE(retry_type, 'standard') = 'standard' AND retry_count < 2)
             OR (retry_type = 'hung_up' AND retry_count < 1)
           )
         ORDER BY
           CASE WHEN retry_type = 'demo_recovery' THEN 0
                WHEN COALESCE(retry_type, 'standard') = 'standard' THEN 1
                ELSE 2 END,
           next_retry_time ASC
         LIMIT 5
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`
    );

    for (const retry of rows) {
      const retryType = retry.retry_type || "standard";
      // A demo recovery follows a live conversation, so it uses the wider
      // callback window; ordinary retries use the business window.
      const window =
        retryType === "demo_recovery"
          ? callbackWindowFor(retry.time_zone)
          : followUpWindow(retry.time_zone, CONFIG.retryWindow);
      const now = new Date();

      if (!inWindow(now, window)) {
        const next = nextInWindow(now, window);
        await pool.query(
          `UPDATE call_retries SET status = 'pending', next_retry_time = $1, updated_at = NOW() WHERE id = $2`,
          [next, retry.id]
        );
        console.log("RETRY OUTSIDE CALLING HOURS - MOVED:", { id: retry.id, next });
        continue;
      }

      try {
        const result = await placeCall({
          phone: retry.phone,
          name: retry.name,
          purpose: "retry",
          retryType,
          variables: { ...(retry.lead_vars || {}), ...retryVariables(retryType) }
        });

        if (result.blocked) {
          const status = result.reason === "dialing_disabled" ? "pending" : "cancelled";
          await pool.query(
            `UPDATE call_retries SET status = $1, last_outcome = $2, updated_at = NOW() WHERE id = $3`,
            [status, `blocked_${result.reason}`, retry.id]
          );
          console.log("RETRY NOT PLACED:", { id: retry.id, reason: result.reason });
          continue;
        }

        await pool.query(
          `UPDATE call_retries
           SET retry_count = retry_count + 1, current_call_id = $1, last_attempt_at = NOW(),
               status = 'waiting_result', updated_at = NOW()
           WHERE id = $2`,
          [result.call_id, retry.id]
        );
        console.log("AUTO RETRY PLACED:", { id: retry.id, retry_type: retryType, call_id: result.call_id });
      } catch (err) {
        console.error(`Automatic retry failed for ID ${retry.id}:`, err.message);
        await pool.query(
          `UPDATE call_retries SET status = 'pending', next_retry_time = NOW() + INTERVAL '30 minutes',
             updated_at = NOW() WHERE id = $1`,
          [retry.id]
        );
      }
    }
  } catch (err) {
    console.error("Automatic retry worker error:", err);
  } finally {
    retryWorkerBusy = false;
  }
}

// =========================================================
// Database setup
// =========================================================

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS callbacks (
      id SERIAL PRIMARY KEY,
      name TEXT,
      phone TEXT NOT NULL,
      callback_time TIMESTAMPTZ NOT NULL,
      time_zone TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()`);
  await pool.query(`ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS call_id TEXT`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_retries (
      id SERIAL PRIMARY KEY,
      original_call_id TEXT NOT NULL,
      phone TEXT NOT NULL,
      name TEXT,
      retry_count INTEGER DEFAULT 0,
      next_retry_time TIMESTAMPTZ,
      status TEXT DEFAULT 'pending',
      last_outcome TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE call_retries ADD COLUMN IF NOT EXISTS current_call_id TEXT`);
  await pool.query(`ALTER TABLE call_retries ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE call_retries ADD COLUMN IF NOT EXISTS retry_type TEXT DEFAULT 'standard'`);
  await pool.query(`ALTER TABLE call_retries ADD COLUMN IF NOT EXISTS lead_vars JSONB DEFAULT '{}'::jsonb`);
  await pool.query(`ALTER TABLE call_retries ADD COLUMN IF NOT EXISTS time_zone TEXT`);
  await pool.query(`ALTER TABLE callbacks ADD COLUMN IF NOT EXISTS lead_vars JSONB DEFAULT '{}'::jsonb`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dnd_numbers (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Every call we know about (batch, callback, retry), used for attempt caps
  // and reporting.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS call_log (
      call_id TEXT PRIMARY KEY,
      phone TEXT,
      source TEXT,
      retry_type TEXT,
      disconnection_reason TEXT,
      duration_ms INTEGER,
      prospect_outcome TEXT,
      in_voicemail BOOLEAN,
      call_successful BOOLEAN,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS call_log_phone_created_idx ON call_log (phone, created_at)`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS demo_bookings (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      name TEXT,
      start_utc TIMESTAMPTZ NOT NULL,
      time_zone TEXT,
      status TEXT NOT NULL DEFAULT 'creating',
      event_id TEXT,
      join_url TEXT,
      call_id TEXT,
      error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (email, start_utc)
    )
  `);

  console.log("Database tables ready");
}

initDatabase()
  .then(() => {
    app.listen(process.env.PORT, () => {
      console.log(`Server running on port ${process.env.PORT}`);
      console.log(
        CONFIG.dialingEnabled
          ? "DIALING ENABLED - callbacks and retries will be placed"
          : "DIALING DISABLED - set DIALING_ENABLED=true to allow the backend to place calls"
      );
      if (!CONFIG.requireSignature) console.warn("WARNING: Retell signature checks are OFF");
    });
    setInterval(processDueCallbacks, 10 * 1000);
    setInterval(processDueRetries, 60 * 1000);
  })
  .catch(err => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
