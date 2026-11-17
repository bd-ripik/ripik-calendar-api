"use strict";

// A one-page, phone-friendly summary of the last N hours of calling:
// health warnings first, then the people who need a human, then the numbers.

const esc = (v) =>
  String(v === null || v === undefined ? "" : v).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));

const REACHED_OUTCOMES = new Set([
  "demo_booked", "callback_requested", "referral_given", "not_interested", "wrong_person", "do_not_call"
]);

function summarizeCalls(rows) {
  const s = {
    outbound: 0, inbound: 0, voicemail: 0, noAnswer: 0, phoneMenu: 0, reached: 0, talked30: 0,
    creditExhausted: 0, outcomes: {}
  };
  for (const r of rows) {
    const d = r.details || {};
    const reason = r.disconnection_reason || "";
    if (reason === "credit_exhausted") { s.creditExhausted++; continue; }
    if (d.direction === "inbound") s.inbound++; else s.outbound++;
    if (r.in_voicemail || reason === "voicemail_reached") { s.voicemail++; continue; }
    if (["dial_no_answer", "dial_busy", "dial_failed", "user_declined"].includes(reason)) { s.noAnswer++; continue; }
    if (["ivr_reached", "invalid_destination"].includes(reason)) { s.phoneMenu++; continue; }
    const secs = Number.isFinite(r.duration_ms) ? r.duration_ms / 1000 : 0;
    if (secs >= 10 || REACHED_OUTCOMES.has(r.prospect_outcome)) s.reached++;
    if (secs >= 30) s.talked30++;
    if (r.prospect_outcome) s.outcomes[r.prospect_outcome] = (s.outcomes[r.prospect_outcome] || 0) + 1;
  }
  return s;
}

function warnings({ stats, dialErrors, failedCallbacks, isWeekday }) {
  const w = [];
  if (stats.creditExhausted > 0) {
    w.push(`${stats.creditExhausted} call(s) failed with "credit exhausted". Add credit in Retell → Billing and check auto-recharge.`);
  }
  if (dialErrors.length > 0) {
    const last = dialErrors[dialErrors.length - 1];
    w.push(`${dialErrors.length} follow-up or callback call(s) could not be started. Last error: ${last.message}`);
  }
  if (failedCallbacks > 0) {
    w.push(`${failedCallbacks} callback(s) failed and need rebooking.`);
  }
  if (isWeekday && stats.outbound === 0) {
    w.push("No calls were placed in this period, although it included a US weekday. Check Retell credit and the Railway service.");
  }
  return w;
}

function personLine(r) {
  const d = r.details || {};
  const who = [d.prospect_name, d.title, d.company].filter(Boolean).join(", ") || "Unknown caller";
  return `${esc(who)} · <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>`;
}

function renderSummaryPage({ hours, generatedAt, stats, warningsList, demos, needsYou, pendingCallbacks, queuedRetries, csvLink }) {
  const card = (label, value) =>
    `<div class="card"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
  const outcomeRows = Object.entries(stats.outcomes)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k.replace(/_/g, " "))}</td><td>${v}</td></tr>`).join("");
  const demoRows = demos.length
    ? demos.map(d => `<li><b>${esc(d.name || d.email)}</b> · ${esc(d.email)}<br>${esc(new Date(d.start_utc).toUTCString())}</li>`).join("")
    : "<li class=muted>None in this period.</li>";
  const needRows = needsYou.length
    ? needsYou.map(n => `<li><b>${esc(n.label)}</b><br>${n.html}${n.summary ? `<div class=muted>${esc(n.summary)}</div>` : ""}</li>`).join("")
    : "<li class=muted>Nothing needs you right now.</li>";

  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sarah: last ${esc(hours)}h</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;margin:0;padding:16px;background:#f6f7f9;color:#111;max-width:640px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:20px 0 8px}
.muted{color:#666;font-size:13px}.warn{background:#fff1f0;border:1px solid #f5c2c0;border-radius:8px;padding:10px 12px;margin:8px 0}
.ok{background:#eefaf0;border:1px solid #bfe5c6;border-radius:8px;padding:10px 12px;margin:8px 0}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.card{background:#fff;border-radius:8px;padding:10px;text-align:center}
.v{font-size:22px;font-weight:600}.l{font-size:12px;color:#555}
ul{padding-left:18px}li{margin:8px 0}table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px}
td{padding:6px 10px;border-bottom:1px solid #eee}a{color:#3b5bdb}
</style></head><body>
<h1>Sarah: last ${esc(hours)} hours</h1>
<div class=muted>Updated ${esc(generatedAt.toUTCString())}</div>
${warningsList.length ? warningsList.map(x => `<div class=warn>⚠️ ${esc(x)}</div>`).join("") : `<div class=ok>✅ Calling is running normally.</div>`}
<h2>Demos booked</h2><ul>${demoRows}</ul>
<h2>Needs you</h2><ul>${needRows}</ul>
<h2>Numbers</h2>
<div class=grid>
${card("calls made", stats.outbound)}${card("people reached", stats.reached)}${card("talked 30s+", stats.talked30)}
${card("voicemails", stats.voicemail)}${card("called us back", stats.inbound)}${card("phone menus / dead", stats.phoneMenu)}
</div>
${outcomeRows ? `<h2>Outcomes</h2><table>${outcomeRows}</table>` : ""}
<h2>Coming up</h2>
<div class=muted>${esc(pendingCallbacks)} callback(s) booked · ${esc(queuedRetries)} follow-up call(s) queued</div>
<p><a href="${esc(csvLink)}">Download the full call report (CSV)</a></p>
</body></html>`;
}

module.exports = { summarizeCalls, warnings, renderSummaryPage, personLine };
