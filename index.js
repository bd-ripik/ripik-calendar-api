require("dotenv").config();
require("isomorphic-fetch");
const { Pool } = require("pg");

const express = require("express");
const { DateTime } = require("luxon");
const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");

const app = express();
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

console.log("TENANT:", process.env.AZURE_TENANT_ID);
console.log("CLIENT:", process.env.AZURE_CLIENT_ID);
console.log("SECRET:", !!process.env.AZURE_CLIENT_SECRET);
console.log("USER:", process.env.USER_EMAIL);

const credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID,
  process.env.AZURE_CLIENT_ID,
  process.env.AZURE_CLIENT_SECRET
);

const authProvider = {
  getAccessToken: async () => {
    const token = await credential.getToken(
      "https://graph.microsoft.com/.default"
    );
    return token.token;
  },
};

const graphClient = Client.initWithMiddleware({ authProvider });

app.get("/", (req, res) => {
  res.send("API is running");
});

app.get("/me", async (req, res) => {
  try {
    const user = await graphClient
      .api(`/users/${process.env.USER_EMAIL}`)
      .get();

    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message,
    });
  }
});

app.get("/calendar", async (req, res) => {
  try {
    const events = await graphClient
      .api(`/users/${process.env.USER_EMAIL}/calendar/events`)
      .top(10)
      .orderby("start/dateTime")
      .get();

    res.json(events);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: err.message,
    });
  }
});

app.post("/book-demo", async (req, res) => {
  try {

    console.log("BOOK DEMO REQUEST:", req.body);

    const {
      name,
      email,
      start,
      timeZone
    } = req.body;

    const startDT = DateTime.fromISO(start, {
      zone: timeZone
    });

    // Meeting duration = 30 minutes
    const endDT = startDT.plus({ minutes: 30 });

    const searchStart = startDT.toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const searchEnd = endDT.toFormat("yyyy-MM-dd'T'HH:mm:ss");

    const schedule = await graphClient
      .api(`/users/${process.env.USER_EMAIL}/calendar/getSchedule`)
      .post({
        schedules: [process.env.USER_EMAIL],

        startTime: {
          dateTime: searchStart,
          timeZone: timeZone
        },

        endTime: {
          dateTime: searchEnd,
          timeZone: timeZone
        },

        availabilityViewInterval: 30
      });

    const isBusy =
      schedule.value[0].scheduleItems &&
      schedule.value[0].scheduleItems.length > 0;

    const availability = schedule.value[0].availabilityView;
    const suggestions = [];

   for (let i = 0; i < availability.length; i++) {
      if (availability[i] === "0") {
        const slot = startDT.plus({ minutes: i * 30 });

        suggestions.push(
          slot
            .setZone(timeZone)
          .toFormat("cccc, LLL d 'at' h:mm a")
        );

    if (suggestions.length === 3) break;
  }
}

    if (isBusy) {
      return res.status(409).json({
        success: false,
        available: false,
        suggestions
      });
    }

    const event = {
      subject: `Ripik <> ${name} - Vision AI Demo Walkthrough`,
      body: {
        contentType: "HTML",
        content: `
        Demo booked by Ripik AI.<br><br>

        Name: ${name}<br>
        Email: ${email}
        `
      },

      start: {
        dateTime: startDT.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        timeZone: timeZone
      },

      end: {
        dateTime: endDT.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
        timeZone: timeZone
      },

      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",

      attendees: [
        {
          emailAddress: {
            address: email,
            name: name
          },
          type: "required"
        }
      ]
    };

    const result = await graphClient
      .api(`/users/${process.env.USER_EMAIL}/calendar/events`)
      .header("Prefer", `outlook.timezone="${timeZone}"`)
      .post(event);

    res.json({
      success: true,
      message: "Meeting booked successfully.",
      joinUrl: result.onlineMeeting.joinUrl,
      eventId: result.id
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });

  }
});

app.post("/check-availability", async (req, res) => {

  try {

    const { start, timeZone } = req.body;

    const startDT = DateTime.fromISO(start, {
      zone: timeZone
    });

    const endDT = startDT.plus({ minutes: 30 });

    const result = await graphClient
      .api(`/users/${process.env.USER_EMAIL}/calendar/getSchedule`)
      .post({

        schedules: [
          process.env.USER_EMAIL
        ],

        startTime: {
          dateTime: startDT.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
          timeZone: timeZone
        },

        endTime: {
          dateTime: endDT.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
          timeZone: timeZone
        },

        availabilityViewInterval: 30

      });

    res.json(result);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });

  }

});

app.get("/current-time", (req, res) => {

  const timeZone = req.query.timeZone || "UTC";

  const now = DateTime.now().setZone(timeZone);

  res.json({
    currentDate: now.toFormat("yyyy-MM-dd"),
    currentTime: now.toFormat("HH:mm:ss"),
    currentDateTime: now.toISO({
      suppressMilliseconds: true
    }),
    timeZone
  });

});

app.post("/resolve-timezone", async (req, res) => {
  try {
    const { city, state, country } = req.body;

    console.log("RESOLVE TIMEZONE REQUEST:", {
      city,
      state,
      country
    });

    // Common country-wide timezones
    const countryMap = {
      "india": "Asia/Kolkata",
      "united kingdom": "Europe/London",
      "uk": "Europe/London",
      "singapore": "Asia/Singapore",
      "japan": "Asia/Tokyo",
      "south korea": "Asia/Seoul",
      "uae": "Asia/Dubai",
      "united arab emirates": "Asia/Dubai"
    };

    const normalizedCountry = (country || "").trim().toLowerCase();

    if (countryMap[normalizedCountry]) {
      return res.json({
        success: true,
        time_zone: countryMap[normalizedCountry],
        source: "country"
      });
    }

    // US state → timezone mapping
    const stateMap = {
      "new york": "America/New_York",
      "new jersey": "America/New_York",
      "pennsylvania": "America/New_York",
      "massachusetts": "America/New_York",
      "virginia": "America/New_York",
      "north carolina": "America/New_York",
      "south carolina": "America/New_York",
      "georgia": "America/New_York",
      "florida": "America/New_York",

      "illinois": "America/Chicago",
      "texas": "America/Chicago",
      "wisconsin": "America/Chicago",
      "minnesota": "America/Chicago",
      "louisiana": "America/Chicago",

      "colorado": "America/Denver",
      "utah": "America/Denver",
      "new mexico": "America/Denver",

      "california": "America/Los_Angeles",
      "washington": "America/Los_Angeles",
      "oregon": "America/Los_Angeles",
      "nevada": "America/Los_Angeles"
    };

    const normalizedState = (state || "").trim().toLowerCase();

    if (stateMap[normalizedState]) {
      return res.json({
        success: true,
        time_zone: stateMap[normalizedState],
        source: "state"
      });
    }

    // Could not confidently determine timezone
    return res.json({
      success: false,
      time_zone: null,
      source: null,
      message: "Timezone could not be determined reliably. Ask the prospect for their timezone."
    });

  } catch (err) {
    console.error("Timezone resolution error:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

async function isDnd(phone) {
  const result = await pool.query(
    `
    SELECT 1
    FROM dnd_numbers
    WHERE phone = $1
    LIMIT 1
    `,
    [phone]
  );

  return result.rows.length > 0;
}

async function makeRetellCallback({ phone, name }) {

  if (await isDnd(phone)) {
    console.log("CALL BLOCKED BY DND:", phone);

    return {
      blocked: true,
      reason: "dnd"
    };
  }

  const response = await fetch(
    "https://api.retellai.com/v2/create-phone-call",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from_number: process.env.RETELL_FROM_NUMBER,
        to_number: phone,
        retell_llm_dynamic_variables: {
          prospect_name: name,
          callback_context: "The prospect previously asked to be called back."
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Retell callback failed: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function makeRetellRetry({ phone, name }) {

  if (await isDnd(phone)) {
    console.log("RETRY BLOCKED BY DND:", phone);

    return {
      blocked: true,
      reason: "dnd"
    };
  }

  const response = await fetch(
    "https://api.retellai.com/v2/create-phone-call",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.RETELL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from_number: process.env.RETELL_FROM_NUMBER,
        to_number: phone,
        retell_llm_dynamic_variables: {
          prospect_name: name || "",
          retry_context:
            "This is an automatic follow-up attempt because the previous outbound call did not connect with the prospect."
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Retell retry failed: ${JSON.stringify(data)}`
    );
  }

  return data;
}

app.post("/test-retell-callback", async (req, res) => {
  try {
    const { phone, name } = req.body;

    const result = await makeRetellCallback({
      phone,
      name
    });

    res.json({
      success: true,
      retell: result
    });

  } catch (err) {
    console.error("Test callback error:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post("/schedule-callback", async (req, res) => {
  try {
    const {
      name,
      phone,
      callback_time,
      time_zone
    } = req.body;

    const result = await pool.query(
      `
      INSERT INTO callbacks
        (name, phone, callback_time, time_zone, status)
      VALUES
        ($1, $2, $3, $4, 'pending')
      RETURNING *
      `,
      [
        name,
        phone,
        callback_time,
        time_zone
      ]
    );

    res.json({
      success: true,
      message: "Callback scheduled",
      callback: result.rows[0]
    });

  } catch (err) {
    console.error("Callback scheduling error:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post("/add-dnd", async (req, res) => {
  try {
    const { phone, reason } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: "Phone number is required"
      });
    }

    await pool.query(
      `
      INSERT INTO dnd_numbers (phone, reason)
      VALUES ($1, $2)
      ON CONFLICT (phone)
      DO UPDATE SET reason = EXCLUDED.reason
      `,
      [
        phone,
        reason || "Prospect requested do not call"
      ]
    );

    await pool.query(
      `
      UPDATE callbacks
      SET status = 'cancelled'
      WHERE phone = $1
        AND status = 'pending'
      `,
      [phone]
    );

    await pool.query(
      `
      UPDATE call_retries
      SET status = 'cancelled',
          updated_at = NOW()
      WHERE phone = $1
        AND status IN ('pending', 'processing', 'waiting_result')
      `,
      [phone]
    );

    console.log("DND ADDED:", phone);

    return res.json({
      success: true,
      message: "Phone number added to DND and pending calls cancelled",
      phone
    });

  } catch (err) {
    console.error("DND error:", err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

function getVoicemailRetryDelayMs(retryCount) {
  // retryCount = number of retries already PLACED

  const schedule = {
    0: 1 * 60 * 60 * 1000,       // Retry #1: +1 hour
    1: 2 * 60 * 60 * 1000,       // Retry #2: +2 hours
    2: 24 * 60 * 60 * 1000,      // Retry #3: +1 day
    3: 2 * 60 * 60 * 1000,       // Retry #4: +2 hours
    4: 24 * 60 * 60 * 1000       // Retry #5: +1 day
  };

  return schedule[retryCount] ?? null;
}

app.post("/retell-webhook", async (req, res) => {
  try {
    const { event, call } = req.body;

    console.log("RETELL WEBHOOK EVENT:", event);

    console.log("RETELL CALL DATA:", {
      call_id: call?.call_id,
      call_status: call?.call_status,
      disconnection_reason: call?.disconnection_reason,
      from_number: call?.from_number,
      to_number: call?.to_number,
      direction: call?.direction,
      duration_ms: call?.duration_ms,
      call_analysis: call?.call_analysis,
      custom_analysis_data: call?.call_analysis?.custom_analysis_data
    });

    // Retry decisions happen only after analysis is complete.
    if (event !== "call_analyzed") {
      return res.status(200).json({
        success: true,
        message: "Event received - no retry decision required"
      });
    }

    const callId = call?.call_id;
    const phone = call?.to_number;
    const disconnectReason = call?.disconnection_reason;

    const analysis = call?.call_analysis;
    const customAnalysis = analysis?.custom_analysis_data;

    const prospectOutcome = customAnalysis?.prospect_outcome;

    // Retell voicemail detection
    const inVoicemail = analysis?.in_voicemail === true;

    const automaticRetryAllowed =
      customAnalysis?.automatic_retry_allowed === true;

    const name =
      call?.retell_llm_dynamic_variables?.prospect_name || null;

    if (!callId || !phone) {
      console.log("RETRY SKIPPED: Missing call ID or phone number");

      return res.status(200).json({
        success: true,
        retry_scheduled: false
      });
    }

    const retryableDisconnectReasons = [
      "dial_no_answer",
      "dial_busy",
      "dial_failed",
      "inactivity"

    ];

    const retryBecauseOfDisconnect =
      retryableDisconnectReasons.includes(disconnectReason);

    const retryBecauseOfAnalysis =
      automaticRetryAllowed === true &&
      prospectOutcome === "no_meaningful_conversation";

    const shouldRetry =
      retryBecauseOfDisconnect ||
      retryBecauseOfAnalysis ||
      inVoicemail;

    // =========================================================
    // STEP A — Is this call already part of an existing retry?
    // =========================================================

    const existingRetryChain = await pool.query(
      `
      SELECT *
      FROM call_retries
      WHERE current_call_id = $1
      LIMIT 1
      `,
      [callId]
    );

    if (existingRetryChain.rows.length > 0) {

      const retry = existingRetryChain.rows[0];

      console.log("RETRY RESULT RECEIVED:", {
        retry_id: retry.id,
        retry_count: retry.retry_count,
        call_id: callId,
        reason: disconnectReason,
        voicemail: inVoicemail,
        outcome: prospectOutcome
      });


      // Retry connected or should not be tried again.
      if (!shouldRetry) {

        await pool.query(
          `
          UPDATE call_retries
          SET status = 'completed',
              last_outcome = $1,
              updated_at = NOW()
          WHERE id = $2
          `,
          [
            prospectOutcome ||
              disconnectReason ||
              "meaningful_conversation",
            retry.id
          ]
        );

        console.log(
          `RETRY CHAIN COMPLETED: ${retry.id}`
        );

        return res.status(200).json({
          success: true,
          retry_scheduled: false,
          retry_chain_completed: true
        });
      }


    // =========================================================
    // Decide retry limit and next retry time
    // =========================================================

    const retryType = retry.retry_type || "standard";

    const maxRetries =
      retryType === "voicemail" ? 5 : 2;


    // Maximum attempts for this retry chain have been reached.
    if (retry.retry_count >= maxRetries) {

      await pool.query(
        `
        UPDATE call_retries
        SET status = 'exhausted',
            last_outcome = $1,
            next_retry_time = NULL,
            updated_at = NOW()
        WHERE id = $2
        `,
        [
          retryType === "voicemail"
            ? "voicemail_retry_exhausted"
            : (
                prospectOutcome ||
                disconnectReason ||
                "retry_exhausted"
              ),
          retry.id
        ]
      );

      console.log("RETRY CHAIN EXHAUSTED:", {
        id: retry.id,
        phone,
        retry_type: retryType,
        retry_count: retry.retry_count
      });

      return res.status(200).json({
        success: true,
        retry_scheduled: false,
        retry_chain_exhausted: true
      });
    }


    // =========================================================
    // Schedule the next retry
    // =========================================================

    let nextDelayMs;

    if (retryType === "voicemail") {

      nextDelayMs =
        getVoicemailRetryDelayMs(retry.retry_count);

    } else {

      // Standard retry behaviour:
      // Retry #2 happens 24 hours after Retry #1.
      nextDelayMs =
        24 * 60 * 60 * 1000;
    }


    if (!nextDelayMs) {

      await pool.query(
        `
        UPDATE call_retries
        SET status = 'exhausted',
            last_outcome = $1,
            next_retry_time = NULL,
            updated_at = NOW()
        WHERE id = $2
        `,
        [
          retryType === "voicemail"
            ? "voicemail_retry_exhausted"
            : "retry_exhausted",
          retry.id
        ]
      );

      console.log(
        `RETRY CHAIN EXHAUSTED: ${retry.id}`
      );

      return res.status(200).json({
        success: true,
        retry_scheduled: false,
        retry_chain_exhausted: true
      });
    }


    const nextRetryTime =
      new Date(Date.now() + nextDelayMs);

    await pool.query(
      `
      UPDATE call_retries
      SET status = 'pending',
          next_retry_time = $1,
          last_outcome = $2,
          updated_at = NOW()
      WHERE id = $3
      `,
      [
        nextRetryTime,
        inVoicemail
          ? "voicemail"
          : (
              prospectOutcome ||
              disconnectReason ||
              "retry_needed"
            ),
        retry.id
      ]
    );

    console.log("NEXT AUTO RETRY QUEUED:", {
      id: retry.id,
      phone,
      retry_type: retryType,
      retry_number: retry.retry_count + 1,
      next_retry_time: nextRetryTime.toISOString()
    });

    return res.status(200).json({
      success: true,
      retry_scheduled: true,
      retry_number: retry.retry_count + 1,
      retry_type: retryType,
      next_retry_time: nextRetryTime.toISOString()
    });
    }


    // =========================================================
    // STEP B — This is an ORIGINAL call, not a retry.
    // =========================================================

    if (!shouldRetry) {

      console.log(
        `RETRY SKIPPED: ${callId} | reason=${disconnectReason} | outcome=${prospectOutcome}`
      );

      return res.status(200).json({
        success: true,
        retry_scheduled: false
      });
    }


    // Prevent duplicate webhook delivery from creating
    // duplicate retry rows.
    const existingOriginalRetry = await pool.query(
      `
      SELECT id
      FROM call_retries
      WHERE original_call_id = $1
      LIMIT 1
      `,
      [callId]
    );

    if (existingOriginalRetry.rows.length > 0) {

      console.log(
        `RETRY SKIPPED: Retry already exists for ${callId}`
      );

      return res.status(200).json({
        success: true,
        retry_scheduled: false,
        duplicate: true
      });
    }

    const retryType = inVoicemail ? "voicemail" : "standard";

    let firstRetryDelayMs;

    if (retryType === "voicemail") {
      firstRetryDelayMs = getVoicemailRetryDelayMs(0);
    } else {
      firstRetryDelayMs = 2 * 60 * 60 * 1000;
    }

    const nextRetryTime =
      new Date(Date.now() + firstRetryDelayMs);

    await pool.query(
      `
      INSERT INTO call_retries
        (
          original_call_id,
          phone,
          name,
          retry_count,
          next_retry_time,
          status,
          last_outcome,
          retry_type
        )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        callId,
        phone,
        name,
        0,
        nextRetryTime,
        "pending",
        inVoicemail
          ? "voicemail"
          : (
              prospectOutcome ||
              disconnectReason ||
              "unknown"
            ),
        retryType
      ]
    );

    console.log(
      `AUTO RETRY QUEUED: ${phone} at ${nextRetryTime.toISOString()}`
    );

    return res.status(200).json({
      success: true,
      retry_scheduled: true,
      retry_number: 1,
      next_retry_time: nextRetryTime.toISOString()
    });

  } catch (err) {

    console.error("Retell webhook error:", err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

async function processDueCallbacks() {
  try {
    const result = await pool.query(`
      SELECT *
      FROM callbacks
      WHERE status = 'pending'
        AND callback_time <= NOW()
      ORDER BY callback_time ASC
      LIMIT 10
    `);

    for (const callback of result.rows) {
      try {
        console.log("Processing callback:", callback);

        const retellResult = await makeRetellCallback({
          phone: callback.phone,
          name: callback.name
        });

        if (retellResult.blocked) {
          await pool.query(
            `
            UPDATE callbacks
            SET status = 'cancelled'
            WHERE id = $1
            `,
            [callback.id]
          );

          console.log("Callback cancelled due to DND:", callback.id);
          continue;
        }

        await pool.query(
          `
          UPDATE callbacks
          SET status = 'completed'
          WHERE id = $1
          `,
          [callback.id]
        );

        console.log("Callback completed:", {
          id: callback.id,
          call_id: retellResult.call_id
        });

      } catch (err) {
        console.error(
          `Callback failed for ID ${callback.id}:`,
          err.message
        );
      }
    }

  } catch (err) {
    console.error("Callback worker error:", err);
  }
}

async function processDueRetries() {
  try {
    const result = await pool.query(`
      SELECT *
      FROM call_retries
      WHERE status = 'pending'
        AND next_retry_time <= NOW()
        AND (
          (retry_type = 'voicemail' AND retry_count < 5)
          OR
          (COALESCE(retry_type, 'standard') = 'standard' AND retry_count < 2)
        )
      ORDER BY next_retry_time ASC
      LIMIT 10
    `);

    for (const retry of result.rows) {
      try {
        console.log("Processing automatic retry:", {
          id: retry.id,
          phone: retry.phone,
          retry_count: retry.retry_count
        });

        // Claim the row first so the worker cannot dial it twice.
        const claimed = await pool.query(
          `
          UPDATE call_retries
          SET status = 'processing',
              updated_at = NOW()
          WHERE id = $1
            AND status = 'pending'
          RETURNING *
          `,
          [retry.id]
        );

        if (claimed.rows.length === 0) {
          continue;
        }

        const retellResult = await makeRetellRetry({
          phone: retry.phone,
          name: retry.name
        });

        if (retellResult.blocked) {
          await pool.query(
            `
            UPDATE call_retries
            SET status = 'cancelled',
              updated_at = NOW()
            WHERE id = $1
            `,
            [retry.id]
          );

          console.log("Retry cancelled due to DND:", retry.id);
          continue;
        }

        const newRetryCount = retry.retry_count + 1;

        await pool.query(
          `
          UPDATE call_retries
          SET retry_count = $1,
              current_call_id = $2,
              last_attempt_at = NOW(),
              status = 'waiting_result',
              updated_at = NOW()
          WHERE id = $3
          `,
          [
            newRetryCount,
            retellResult.call_id,
            retry.id
          ]
        );

        console.log("AUTO RETRY PLACED:", {
          id: retry.id,
          phone: retry.phone,
          retry_number: newRetryCount,
          call_id: retellResult.call_id
        });

      } catch (err) {
        console.error(
          `Automatic retry failed for ID ${retry.id}:`,
          err.message
        );

        await pool.query(
          `
          UPDATE call_retries
          SET status = 'pending',
              updated_at = NOW()
          WHERE id = $1
          `,
          [retry.id]
        );
      }
    }

  } catch (err) {
    console.error("Automatic retry worker error:", err);
  }
}

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

  await pool.query(`
    ALTER TABLE call_retries
    ADD COLUMN IF NOT EXISTS current_call_id TEXT
  `);

  await pool.query(`
    ALTER TABLE call_retries
    ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ
  `);

  await pool.query(`
    ALTER TABLE call_retries
    ADD COLUMN IF NOT EXISTS retry_type TEXT DEFAULT 'standard'
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dnd_numbers (
      id SERIAL PRIMARY KEY,
      phone TEXT UNIQUE NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  
  console.log("Callbacks, retry and DND tables ready");
}

initDatabase()
  .then(() => {
    app.listen(process.env.PORT, () => {
      console.log(`Server running on port ${process.env.PORT}`);
    });
    setInterval(processDueCallbacks, 10 * 1000);
    setInterval(processDueRetries, 60 * 1000);
  })
  .catch((err) => {
    console.error("Database initialization failed:", err);
    process.exit(1);
  });
