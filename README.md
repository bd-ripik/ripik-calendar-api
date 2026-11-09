# Ripik AI BDR backend

Node/Express service on Railway that sits behind the Retell voice agent "Ava".

- **Tools Ava calls during a call:** `POST /demo-slots`, `POST /book-demo`, `POST /schedule-callback`, `POST /add-dnd`, `GET|POST /current-time`, `POST /resolve-timezone`, `POST /check-availability`
- **Retell webhook:** `POST /retell-webhook`. It records every call in `call_log` and decides on automatic retries after `call_analyzed`.
- **Workers:** every 10 s for requested callbacks and every 60 s for automatic retries and demo recovery. They only dial when `DIALING_ENABLED=true`.
- **Health:** `GET /health`

## Safety rules built in

| Rule | Where |
|---|---|
| No backend dialling unless `DIALING_ENABLED=true` | `placeCall`, workers |
| Every Retell request must carry a valid `X-Retell-Signature` | `requireRetell` |
| DND checked before every backend call; DND cancels queued follow-ups | `placeCall`, `addToDnd` |
| Automatic retries only on weekdays, 11:00–17:00 Eastern | `lib/callingWindow.js` |
| Requested callbacks only 08:00–21:00 in the prospect's zone | `lib/callingWindow.js` |
| Retries stop after `MAX_CALLS_PER_NUMBER_7D` calls in 7 days, or after any real conversation in 30 days | `placeCall` |
| Each queued call is claimed atomically (no double dialling) | workers (`FOR UPDATE SKIP LOCKED`) |
| A demo is booked at most once per email and start time | `demo_bookings`, Graph `transactionId` |
| Demo slots fit the prospect's hours (9–7 local), the team's hours if set, and the checked calendars | `suggestSlots`, `isSlotBusy` |

## How demos are booked

When the prospect agrees, the agent calls `Get_Demo_Slots` and then `Book_Demo_Meeting`. The backend creates a 30-minute Teams meeting in the calendar of the `USER_EMAIL` mailbox (bd@ripik.ai) through Microsoft Graph, using the Azure app "Ripik AI Telecalling Scheduler". The invite goes to the prospect from that mailbox. Everyone in `DEMO_ATTENDEES` is added to the invite and their calendars are checked before a time is offered. Everyone in `DEMO_NOTIFY_EMAILS` is copied on the invite without a calendar check. Offered times are 9:00–19:00 in the prospect's time zone on weekdays (`DEMO_HOURS_START`/`DEMO_HOURS_END`).

## Tables

`callbacks`, `call_retries`, `dnd_numbers`, `call_log`, `demo_bookings`. They are created or updated automatically on start-up.

Statuses:
- **Callbacks:** `pending → dialing → completed | failed | cancelled`
- **Retries:** `pending → processing → waiting_result → pending | completed | exhausted | cancelled`
- `paused` and `parked_*` rows are never dialled.

## Before switching dialling back on

1. Set the Railway variables listed in `.env.example`. `DIALING_ENABLED` stays `false` at first.
2. Make sure `RETELL_API_KEY` is the key with the Webhook badge.
3. Place one test call to an internal number and check the logs show a signed webhook and the tool calls succeed.
4. Only then set `DIALING_ENABLED=true`.

## Tests

```
npm test
```

The tests cover phone normalisation, signature checks, calling windows, time zone resolution and demo slot suggestions.
