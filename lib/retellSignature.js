"use strict";

const crypto = require("crypto");

// Retell signs every webhook and every custom-function (tool) request with an
// X-Retell-Signature header of the form "v=<unix ms>,d=<hex>", where
// d = HMAC-SHA256(key = Retell API key with the webhook badge,
//                 message = raw request body + timestamp).
// For GET requests the body is the empty string.

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1000;

function verifyRetellSignature(rawBody, apiKey, header, options = {}) {
  const now = options.now ?? Date.now();
  const toleranceMs = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  if (!apiKey || typeof header !== "string") return false;

  const match = /^v=(\d+),d=([0-9a-fA-F]+)$/.exec(header.trim());
  if (!match) return false;

  const timestamp = match[1];
  const digest = match[2].toLowerCase();

  if (Math.abs(now - Number(timestamp)) > toleranceMs) return false;

  const expected = crypto
    .createHmac("sha256", apiKey)
    .update((rawBody || "") + timestamp)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(digest, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Helper used by tests (and handy for manual testing with curl).
function signForTest(rawBody, apiKey, timestamp = Date.now()) {
  const d = crypto
    .createHmac("sha256", apiKey)
    .update((rawBody || "") + String(timestamp))
    .digest("hex");
  return `v=${timestamp},d=${d}`;
}

module.exports = { verifyRetellSignature, signForTest };
