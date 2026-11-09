"use strict";

// Phone helpers shared by every endpoint and worker, so the same number is
// always stored and compared in the same E.164 form.

function hasTemplateVariable(value) {
  return typeof value === "string" && (value.includes("{{") || value.includes("}}"));
}

// Returns an E.164 string ("+13125551234") or null if the input can't be
// turned into a plausible number.
//  - "+..."            -> kept, digits only
//  - 10 digits         -> assumed US/Canada, "+1" added
//  - 11 digits, "1..." -> "+" added
//  - anything else     -> null (we never guess a country code)
function normalizePhone(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw || hasTemplateVariable(raw)) return null;

  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return null;

  let e164;
  if (raw.startsWith("+")) {
    e164 = "+" + digits;
  } else if (digits.length === 10) {
    e164 = "+1" + digits;
  } else if (digits.length === 11 && digits.startsWith("1")) {
    e164 = "+" + digits;
  } else {
    return null;
  }

  return /^\+[1-9]\d{7,14}$/.test(e164) ? e164 : null;
}

function isValidResolvedPhone(value) {
  return normalizePhone(value) !== null;
}

module.exports = { normalizePhone, isValidResolvedPhone, hasTemplateVariable };
