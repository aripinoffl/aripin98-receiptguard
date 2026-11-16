/**
 * ReceiptGuard — proof-checked payment release agent (Wildcard track).
 *
 * A claimant submits a payment / reimbursement claim. ReceiptGuard applies a
 * deterministic release policy and, for every decision, generates a real
 * Groth16 proof (snarkjs, official zkVerify gatekeeper circuit) whose public
 * signals encode the claim fields and the decision bit — then verifies that
 * proof server-side before answering, so a response is never an unproven
 * claim. Public demo service: no secrets, no HMAC; the salt is a fixed demo
 * derivation from the claim id so anyone can reproduce a decision.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

export const BN128_PRIME =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Registered gatekeeper verification-key hash (official circuit artifacts). */
export const REGISTERED_VK =
  "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CIRCUITS_DIR = process.env.CIRCUITS_DIR || path.join(DIR, "circuits");
const WASM_PATH = path.join(CIRCUITS_DIR, "gatekeeper.wasm");
const ZKEY_PATH = path.join(CIRCUITS_DIR, "gatekeeper_final.zkey");
const VK_PATH = path.join(CIRCUITS_DIR, "verification_key.json");

const ARTIFACT_SHA256 = {
  "gatekeeper.wasm": "be00aefe3c8ba910951a242f50e55937bf82a0375ad4b69c2ef10629ab92764f",
  "gatekeeper_final.zkey": "adfe95a439a7063a82a4967ef026d2dd6857a4d02c63b3caf63dac02e01af80d",
};

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

let wasmBuf, zkeyBuf, vkJson;
let readyPromise = null;
export function ensureReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      for (const [name, file] of [["gatekeeper.wasm", WASM_PATH], ["gatekeeper_final.zkey", ZKEY_PATH]]) {
        const buf = fs.readFileSync(file);
        if (sha256Hex(buf) !== ARTIFACT_SHA256[name]) {
          throw new Error(`circuit artifact ${name}: sha256 mismatch — refusing to run`);
        }
        if (name.endsWith(".wasm")) wasmBuf = buf; else zkeyBuf = buf;
      }
      vkJson = JSON.parse(fs.readFileSync(VK_PATH, "utf8"));
    })();
    readyPromise.catch(() => { readyPromise = null; });
  }
  return readyPromise;
}

let proveChain = Promise.resolve();
function prove(inputs) {
  const run = proveChain.then(() => snarkjs.groth16.fullProve(inputs, wasmBuf, zkeyBuf));
  proveChain = run.then(() => {}, () => {});
  return run;
}

export function toFieldElement(v) {
  let n;
  const s = String(v).trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) n = BigInt(s);
  else if (/^[0-9]+$/.test(s)) n = BigInt(s);
  else n = BigInt("0x" + crypto.createHash("sha256").update(s).digest("hex"));
  return (((n % BN128_PRIME) + BN128_PRIME) % BN128_PRIME).toString(10);
}

export function parseUint(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return BigInt(s);
  if (/^[0-9]+$/.test(s)) return BigInt(s);
  return null;
}

/** Fixed demo salt: SHA-256("receiptguard-salt:" + claim_id) mod p. Public and reproducible. */
export function deriveDemoSalt(claimId) {
  const d = crypto.createHash("sha256").update(`receiptguard-salt:${claimId}`).digest();
  return BigInt("0x" + d.toString("hex")) % BN128_PRIME;
}

/**
 * Parse a public claim. Friendly field names; `expected_recipient` is the
 * recipient written on the approved receipt/invoice the claim is checked
 * against (defaults to `recipient`, i.e. no mismatch).
 */
export function parseClaim(c) {
  if (!c || typeof c !== "object") return null;
  const minimum = parseUint(c.minimum);
  const balance = parseUint(c.balance);
  const amount = parseUint(c.amount);
  const cap = parseUint(c.max_amount ?? c.cap);
  const expiryBlock = parseUint(c.expiry_block);
  const currentBlock = parseUint(c.current_block);
  if ([minimum, balance, amount, cap, expiryBlock, currentBlock].some((x) => x === null)) return null;
  if (typeof c.recipient !== "string" || !c.recipient) return null;
  const expected = c.expected_recipient ?? c.recipient;
  if (typeof expected !== "string" || !expected) return null;
  return {
    claimId: typeof c.claim_id === "string" && c.claim_id ? c.claim_id : "claim-demo",
    registeredVk: REGISTERED_VK,
    proofVk: REGISTERED_VK,
    minimum, publicBalance: balance, amount, maxTransfer: cap,
    expiryBlock, currentBlock,
    recipient: c.recipient, conditionRecipient: expected,
    proofTx: typeof c.proof_ref === "string" && c.proof_ref ? c.proof_ref : "receiptguard-demo",
  };
}

/** Deterministic release policy — precedence and boundaries mirror the circuit exactly. */
export function evaluateClaim(p) {
  if (p.publicBalance < p.minimum) return { decision: "REJECT", reason_code: "THRESHOLD_MISMATCH" };
  if (p.currentBlock >= p.expiryBlock) return { decision: "REJECT", reason_code: "EXPIRED_CONDITION" };
  if (p.recipient.trim().toLowerCase() !== p.conditionRecipient.trim().toLowerCase())
    return { decision: "REJECT", reason_code: "RECIPIENT_MISMATCH" };
  if (p.amount > p.maxTransfer) return { decision: "REJECT", reason_code: "AMOUNT_OVERFLOW" };
  return { decision: "APPROVE", reason_code: "VALID_CONDITION" };
}

export function buildCircuitInputs(claimId, p, decision, salt) {
  return {
    taskId: toFieldElement(claimId),
    registeredVkHash: toFieldElement(p.registeredVk),
    proofVkHash: toFieldElement(p.proofVk),
    minimum: p.minimum.toString(10),
    publicBalance: p.publicBalance.toString(10),
    expiryBlock: p.expiryBlock.toString(10),
    currentBlock: p.currentBlock.toString(10),
    recipient: toFieldElement(p.recipient),
    conditionRecipient: toFieldElement(p.conditionRecipient),
    amount: p.amount.toString(10),
    maxTransfer: p.maxTransfer.toString(10),
    decision: decision === "APPROVE" ? "1" : "0",
    salt: salt.toString(10),
  };
}

/** Evaluate a claim, prove the decision, verify the proof, return the full result. */
export async function checkClaim(rawClaim) {
  await ensureReady();
  const parsed = parseClaim(rawClaim);
  if (!parsed) return { decision: "REJECT", reason_code: "INVALID_CLAIM", verified: false };
  const outcome = evaluateClaim(parsed);
  const inputs = buildCircuitInputs(parsed.claimId, parsed, outcome.decision, deriveDemoSalt(parsed.claimId));
  const { proof, publicSignals } = await prove(inputs);
  const verified = await snarkjs.groth16.verify(vkJson, publicSignals, proof);
  return {
    claim_id: parsed.claimId,
    decision: outcome.decision,
    reason_code: outcome.reason_code,
    proof: { pi_a: proof.pi_a, pi_b: proof.pi_b, pi_c: proof.pi_c, protocol: "groth16", curve: "bn128" },
    public_signals: publicSignals,
    verified,
    proof_ref: parsed.proofTx,
  };
}
