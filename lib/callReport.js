"use strict";

// Pulls the fields worth reviewing out of a Retell call object (webhook
// payload or get-call response), and turns rows into a CSV file.

function callDetails(call) {
  if (!call || typeof call !== "object") return null;
  const analysis = call.call_analysis || {};
  const custom = analysis.custom_analysis_data || {};
  const vars = call.retell_llm_dynamic_variables || {};
  const transcript = typeof call.transcript === "string" && call.transcript.trim() ? call.transcript.trim() : null;

  return {
    transcript,
    summary: typeof analysis.call_summary === "string" ? analysis.call_summary : null,
    user_sentiment: typeof analysis.user_sentiment === "string" ? analysis.user_sentiment : null,
    details: {
      direction: call.direction || null,
      prospect_name: vars.prospect_name || null,
      title: vars.title || null,
      company: vars.company || null,
      industry: vars.industry || null,
      state: vars.state || null,
      callback_context: vars.callback_context || null,
      retry_type: vars.retry_type || null,
      main_objection: custom.main_objection || null,
      demo_intent_incomplete: typeof custom.demo_intent_incomplete === "boolean" ? custom.demo_intent_incomplete : null,
      dnd_requested: typeof custom.dnd_requested === "boolean" ? custom.dnd_requested : null,
      agent_version: Number.isFinite(call.agent_version) ? call.agent_version : null
    }
  };
}

const REPORT_COLUMNS = [
  "time_utc", "call_id", "phone", "prospect_name", "title", "company", "industry", "state",
  "direction", "call_type", "agent_version", "disconnection_reason", "duration_s",
  "prospect_outcome", "main_objection", "call_successful", "in_voicemail", "user_sentiment",
  "summary", "transcript"
];

function reportRow(r) {
  const d = r.details || {};
  const callType = d.callback_context ? "callback" : d.retry_type ? `retry:${d.retry_type}` : d.direction || "";
  return {
    time_utc: r.created_at ? new Date(r.created_at).toISOString() : "",
    call_id: r.call_id,
    phone: r.phone,
    prospect_name: d.prospect_name,
    title: d.title,
    company: d.company,
    industry: d.industry,
    state: d.state,
    direction: d.direction,
    call_type: callType,
    agent_version: d.agent_version,
    disconnection_reason: r.disconnection_reason,
    duration_s: Number.isFinite(r.duration_ms) ? Math.round(r.duration_ms / 1000) : "",
    prospect_outcome: r.prospect_outcome,
    main_objection: d.main_objection,
    call_successful: r.call_successful,
    in_voicemail: r.in_voicemail,
    user_sentiment: r.user_sentiment,
    summary: r.summary,
    transcript: r.transcript
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  let s = String(value);
  // Stop spreadsheets from treating a cell as a formula.
  if (/^[=+\-@]/.test(s) && !/^\+\d+$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, columns = REPORT_COLUMNS) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map(c => csvCell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

module.exports = { callDetails, reportRow, toCsv, REPORT_COLUMNS };
