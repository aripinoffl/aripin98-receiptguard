/**
 * ReceiptGuard HTTP service (plain node:http, no framework).
 *   GET  /           landing page + live try-it form (public/index.html)
 *   GET  /agent      health { ok: true }
 *   POST /agent      check a claim  (also POST /api/check)
 * Import with RECEIPTGUARD_NO_LISTEN=1 (Vercel functions) to skip listen.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkClaim, ensureReady } from "./receiptguard.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.PORT || "8790", 10);
const MAX_BODY = 100_000;
const LANDING = path.join(DIR, "public", "index.html");

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/" && req.method === "GET") {
    try {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fs.readFileSync(LANDING));
    } catch { sendJson(res, 500, { error: "landing_missing" }); }
    return;
  }
  if ((url.pathname === "/agent" || url.pathname === "/api/check") && req.method === "GET") {
    return sendJson(res, 200, { ok: true, service: "receiptguard" });
  }
  if ((url.pathname === "/agent" || url.pathname === "/api/check") && req.method === "POST") {
    (async () => {
      let raw;
      try { raw = await readBody(req); } catch { return sendJson(res, 413, { error: "body_too_large" }); }
      let claim;
      try { claim = JSON.parse(raw.toString("utf8")); } catch { return sendJson(res, 400, { decision: "REJECT", reason_code: "INVALID_CLAIM", verified: false }); }
      try {
        const t0 = Date.now();
        const result = await checkClaim(claim);
        console.log(`claim ${result.claim_id ?? "?"} -> ${result.reason_code} verified=${result.verified} in ${Date.now() - t0} ms`);
        return sendJson(res, 200, result);
      } catch (e) {
        console.error(`check failed: ${e.stack ?? e}`);
        return sendJson(res, 500, { error: "internal_error" });
      }
    })();
    return;
  }
  return sendJson(res, 404, { error: "not_found" });
}

export const server = http.createServer(handleRequest);

// Vercel's Node preset may load this file directly as the function entry:
// a default export keeps it valid there, and the listen below is skipped
// in any serverless environment (VERCEL is set by the platform).
export default handleRequest;

if (process.env.RECEIPTGUARD_NO_LISTEN !== "1" && !process.env.VERCEL) {
  ensureReady()
    .then(() => server.listen(PORT, () => console.log(`receiptguard listening on :${PORT} (GET /, POST /agent, POST /api/check)`)))
    .catch((e) => { console.error(`FATAL: startup failed: ${e.message}`); process.exit(1); });
}
