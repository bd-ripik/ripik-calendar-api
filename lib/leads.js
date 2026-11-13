"use strict";

const { normalizePhone } = require("./phone");
const { leadVariables } = require("./followUp");

// Minimal RFC 4180 CSV parser: quoted fields, "" escapes, CRLF or LF.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const s = String(text || "").replace(/^﻿/, "");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  row.push(field);
  if (row.some(v => v.trim() !== "")) rows.push(row);
  return rows;
}

// Campaign CSV (phone_number, prospect_name, title, company, industry, email,
// city, state, country) -> [{ phone, vars }]. Rows without a usable phone are
// reported back rather than stored.
function leadsFromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { leads: [], skipped: [], error: "The file has no data rows." };

  const header = rows[0].map(h => h.trim().toLowerCase());
  const phoneCol = header.indexOf("phone_number");
  if (phoneCol === -1) return { leads: [], skipped: [], error: "No phone_number column found." };

  const leads = [];
  const skipped = [];
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const record = Object.fromEntries(header.map((h, j) => [h, (rows[i][j] || "").trim()]));
    const phone = normalizePhone(record.phone_number);
    if (!phone) { skipped.push({ row: i + 1, value: record.phone_number }); continue; }
    if (seen.has(phone)) continue;
    seen.add(phone);
    leads.push({ phone, vars: leadVariables(record) });
  }
  return { leads, skipped, error: null };
}

module.exports = { parseCsv, leadsFromCsv };
