/**
 * ReceiptGuard end-to-end tests: start the service on a test port, then
 * check one valid claim and four rejection shapes over real HTTP.
 * Every decision must carry a Groth16 proof that the service verified.
 */
import { spawn } from "node:child_process";

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn("node", ["server.mjs"], {
  cwd: new URL(".", import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (d) => (serverLog += d));
child.stderr.on("data", (d) => (serverLog += d));

const VALID = {
  claim_id: "test-valid-1",
  recipient: "0x1111111111111111111111111111111111111111",
  expected_recipient: "0x1111111111111111111111111111111111111111",
  amount: "500", max_amount: "1000",
  balance: "1460", minimum: "1000",
  expiry_block: "19842201", current_block: "19832000",
  proof_ref: "receipt-test-001",
};

const CASES = [
  { name: "valid claim approves", claim: VALID, decision: "APPROVE", reason: "VALID_CONDITION" },
  { name: "balance below minimum rejects", claim: { ...VALID, claim_id: "test-threshold", balance: "900" }, decision: "REJECT", reason: "THRESHOLD_MISMATCH" },
  { name: "expired claim rejects", claim: { ...VALID, claim_id: "test-expired", current_block: "19842201" }, decision: "REJECT", reason: "EXPIRED_CONDITION" },
  { name: "amount above cap rejects", claim: { ...VALID, claim_id: "test-overflow", amount: "1001" }, decision: "REJECT", reason: "AMOUNT_OVERFLOW" },
  { name: "recipient mismatch rejects", claim: { ...VALID, claim_id: "test-recipient", expected_recipient: "0x2222222222222222222222222222222222222222" }, decision: "REJECT", reason: "RECIPIENT_MISMATCH" },
];

let passed = 0, failed = 0;
function check(name, cond, extra = "") {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${extra}`); }
}

try {
  // Wait for the server to come up (artifact load + listen).
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    try { const r = await fetch(`${BASE}/agent`); up = r.ok; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  check("server starts and health-checks", up, serverLog.slice(-300));
  if (!up) throw new Error("server did not start");

  const landing = await fetch(`${BASE}/`);
  const landingText = await landing.text();
  check("landing page serves the demo form", landing.ok && landingText.includes("ReceiptGuard") && landingText.includes("Try it live"));

  for (const c of CASES) {
    const t0 = Date.now();
    const res = await fetch(`${BASE}/agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c.claim),
    });
    const j = await res.json();
    check(`${c.name}: decision`, j.decision === c.decision, JSON.stringify(j).slice(0, 200));
    check(`${c.name}: reason code`, j.reason_code === c.reason, j.reason_code);
    check(`${c.name}: proof present`, !!j.proof?.pi_a && Array.isArray(j.public_signals) && j.public_signals.length === 13);
    check(`${c.name}: proof verified server-side`, j.verified === true, `verified=${j.verified}`);
    console.log(`  (${Date.now() - t0} ms)`);
  }

  const bad = await fetch(`${BASE}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ claim_id: "x" }) });
  const badJson = await bad.json();
  check("malformed claim rejects as INVALID_CLAIM", badJson.decision === "REJECT" && badJson.reason_code === "INVALID_CLAIM");
} finally {
  child.kill("SIGTERM");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
