# Retell setup for the new Sarah prompt

Replace `<RAILWAY_URL>` with the service's public URL, for example `https://ripik-calendar-api-production.up.railway.app`.

## 1. Prompt

Paste `sarah-prompt.md` into the agent's prompt, replacing the old one.

Also, in the agent settings:
- set the agent name to Sarah;
- pick a natural US English female voice that matches the name:
  1. open the agent;
  2. click the voice selector (near the top of the agent page, next to the language and model, or under Global settings, then Voice & Language);
  3. filter to English, female, American accent;
  4. preview a few and pick one;
  5. save and publish the agent.

## 2. Tools (custom functions)

For every custom function:
- **Turn "Payload: args only" OFF.** The backend then also receives the call itself. It uses the call to find the prospect's number when a phone argument is wrong, and to link bookings to calls. The backend accepts both formats, so this is safe to change.
- Retell signs every tool request automatically. Nothing to configure.

| Tool name | Method and URL | Parameters (all strings) |
|---|---|---|
| `Get_Demo_Slots` **(new)** | POST `<RAILWAY_URL>/demo-slots` | `timeZone` (required, IANA zone such as America/New_York), `date` (optional, YYYY-MM-DD preferred day), `requested_start` (optional, exact time the prospect proposed, e.g. 2026-11-12T16:00) |
| `Book_Demo_Meeting` | POST `<RAILWAY_URL>/book-demo` | `name`, `email`, `start` (ISO 8601), `timeZone` — all required |
| `schedule_callback` | POST `<RAILWAY_URL>/schedule-callback` | `name`, `phone`, `callback_time` (ISO 8601), `time_zone` |
| `add_to_dnd` | POST `<RAILWAY_URL>/add-dnd` | `phone`, `reason` |
| `resolve_timezone` | POST `<RAILWAY_URL>/resolve-timezone` | `city`, `state`, `country` |
| `Get_Current_Time` | POST `<RAILWAY_URL>/current-time` | `timeZone` (optional) |
| `end_call` | built-in | — |

Suggested descriptions, which the agent reads to decide when to use each tool:
- **Get_Demo_Slots:** "Get free 30-minute demo times in the prospect's time zone. Call this before proposing times. Pass date for a preferred day, or requested_start to check an exact time the prospect proposed (the reply says requested_available true or false). Each slot has a label to say aloud and a start value to pass to Book_Demo_Meeting."
- **Book_Demo_Meeting:** "Book the 30-minute Teams demo. Only after the email is confirmed and a time is agreed."
- **schedule_callback:** "Schedule a call back at the time the prospect asked for. Phone is {{user_number}}."
- **add_to_dnd:** "Permanently stop calling this number. Phone is {{user_number}}."

## 3. Default dynamic variables (agent level)

Set each of these to an empty string, so that a missing value never appears to Sarah as raw `{{...}}` text:

`prospect_name`, `title`, `company`, `industry`, `email`, `city`, `state`, `country`, `callback_context`, `retry_type`, `retry_context`

`{{user_number}}` and `{{current_time_America/New_York}}` are filled in by Retell automatically.

## 4. Post-call analysis fields

Keep the existing fields: `prospect_outcome`, `automatic_retry_allowed`, `demo_intent_incomplete`, `dnd_requested`.

Update `prospect_outcome` so its options are:
- `demo_booked`
- `callback_requested`
- `interested`
- `not_interested`
- `wrong_person`
- `referral_given`
- `info_requested`
- `do_not_call`
- `no_meaningful_conversation` (also use this for voicemail, IVR, a receptionist who didn't connect, and silence)

Add these new text fields, filled in only when they apply:
- `referral_name`, `referral_role`: who the prospect said to contact instead.
- `info_requested_email`: the email given when the prospect wanted information but no demo.
- `main_objection`: one of `busy`, `send_email`, `has_solution`, `no_budget`, `not_relevant`, `not_decision_maker`, `other`, `none`.

The backend already reads `prospect_outcome`, `automatic_retry_allowed`, `demo_intent_incomplete` and `dnd_requested`. The new fields are for the team's follow-up and reporting.

### Call Successful (built-in field)

Success means a demo was booked, and nothing else. Edit the **Call Successful** prompt in Post Call Extraction to:

> Mark the call successful ONLY if a demo meeting was actually booked during this call. That means the Book_Demo_Meeting tool was called and its response contained "success": true, or the agent confirmed the booking to the prospect with words like "You're booked for [day and time]". Everything else is NOT successful, including: a callback scheduled, interest shown, information or an email requested, a referral given, voicemail, a phone menu (IVR), a wrong or dead number, a short call or hang-up, a do-not-call request, and a demo the prospect agreed to but that was not booked (for example because the booking failed or the call dropped). If you are unsure, mark the call unsuccessful.

## 5. Agent settings to keep

These are as configured in August and don't need changing:
- User speaks first.
- Hang up on voicemail.
- End call after 15 seconds of silence, with one reminder.
- Maximum call duration limit.
- Webhook URL set to `<RAILWAY_URL>/retell-webhook`, with the call_started, call_ended and call_analyzed events.

## 6. Batch CSV columns

The columns below become the dynamic variables of the same name. Send each lead file for cleaning before upload: duplicates, shared switchboard numbers, DND numbers and people already spoken to are removed.

```
phone_number,prospect_name,title,company,industry,email,city,state,country
```

## 7. Inbound calls

Check what happens when someone calls back `+1 447 226 1059`. People often return a missed call. If no agent answers inbound calls on that number, assign one (the same Sarah agent works), so those callers can book a demo too.
