require("dotenv").config();
require("isomorphic-fetch");

const express = require("express");
const { DateTime } = require("luxon");
const { ClientSecretCredential } = require("@azure/identity");
const { Client } = require("@microsoft/microsoft-graph-client");

const app = express();
app.use(express.json());

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
      subject: `Ripik AI Demo - ${name}`,
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

app.post("/schedule-callback", async (req, res) => {
  try {
    const {
      name,
      phone,
      callback_time,
      time_zone
    } = req.body;

    console.log("Callback requested:", {
      name,
      phone,
      callback_time,
      time_zone
    });

    res.json({
      success: true,
      message: "Callback scheduled",
      name,
      phone,
      callback_time,
      time_zone
    });

  } catch (err) {
    console.error("Callback scheduling error:", err);

    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
