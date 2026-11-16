/**
 * Vercel serverless entry for ReceiptGuard. vercel.json rewrites
 * /agent -> /api/check and / -> /api/check?landing=1.
 * bodyParser is disabled so the handler reads the raw request stream.
 */
process.env.RECEIPTGUARD_NO_LISTEN ??= "1";

const { ensureReady } = await import("../receiptguard.mjs");
const { handleRequest } = await import("../server.mjs");

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  try {
    await ensureReady();
  } catch (e) {
    console.error(`receiptguard not ready: ${e.stack ?? e}`);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "agent_not_ready" }));
    return;
  }
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/api/check") req.url = (req.method === "GET" && url.searchParams.get("landing") === "1") ? "/" : "/agent";
    else if (url.pathname === "/agent" || url.pathname === "/") req.url = url.pathname;
  } catch { /* leave req.url untouched */ }
  handleRequest(req, res);
}
