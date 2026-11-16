# ReceiptGuard — proof-checked payment release agent

*A Wildcard entry for the zkVerify Agent Games (Season 01), by @aripin98.*

> Most payment agents ask you to trust their decision. ReceiptGuard **proves** it.

## The problem

Every day, small teams, DAOs, grant programs, freelance marketplaces and community treasuries release payments and reimbursements the same way: a person eyeballs a claim — right recipient? within budget? still valid? — and clicks pay. It is slow, inconsistent between reviewers, and worst of all **unauditable**: when a payment is later disputed, there is no evidence the release rules were actually followed, only someone's say-so.

## Who it helps

- **DAO / community treasuries** releasing contributor payments against approved budgets.
- **Grant and bounty programs** paying out claims that must match an approved award.
- **Small teams** processing expense reimbursements against a policy cap.
- **Marketplaces** releasing escrowed funds when the stated conditions hold.

Anyone who releases money against written rules and may later need to *show their work*.

## What it does

A claimant submits a payment claim — recipient, amount, cap, available balance, minimum balance, expiry block vs. current block, and a receipt/proof reference. ReceiptGuard:

1. Applies a **deterministic, fail-closed release policy** and returns `APPROVE` or `REJECT` with a machine-readable reason code (`VALID_CONDITION`, `THRESHOLD_MISMATCH`, `EXPIRED_CONDITION`, `RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`).
2. Generates a **real Groth16 proof** of that decision with the official zkVerify gatekeeper circuit (snarkjs, local proving, ~0.3–1 s per claim).
3. **Verifies its own proof server-side** against the circuit verification key before answering, and returns the proof plus its 13 public signals — so any third party can independently verify that the stated decision is the *only* one the rules allow for those claim fields.

A rejection is proved just like an approval: the proof does not say "trust me, it was fine" — it proves the decision bit equals the conjunction of the field checks, whichever way it came out.

## Live demo

- **Landing page + try-it form:** `GET /` on the public endpoint (see *Live endpoint* below) — submit a claim in the browser and see the decision, reason code, proof, and verification result. Change the amount above the cap or the balance below the minimum and watch a *proved rejection* come back.
- **API:** `POST /agent` (alias `POST /api/check`) with a JSON claim:

```json
{
  "claim_id": "demo-claim-1",
  "recipient": "0x1111111111111111111111111111111111111111",
  "expected_recipient": "0x1111111111111111111111111111111111111111",
  "amount": "500",
  "max_amount": "1000",
  "balance": "1460",
  "minimum": "1000",
  "expiry_block": "19842201",
  "current_block": "19832000",
  "proof_ref": "receipt-001"
}
```

Response: `{ claim_id, decision, reason_code, proof { pi_a, pi_b, pi_c, protocol, curve }, public_signals [13], verified, proof_ref }`.

- **Health:** `GET /agent` → `{ "ok": true, "service": "receiptguard" }`.

## How it works

- **Policy mirrors the circuit.** The circuit asserts `decision == AND(five field checks)`, so the agent's policy is an exact mirror, not an interpretation: balance ≥ minimum passes, current block < expiry block passes, amount ≤ cap passes, recipient must equal the recipient on the approved receipt. Checks run in a fixed precedence (threshold → expiry → recipient → amount) so the reason code is deterministic.
- **Signal construction.** The 12 public inputs are the claim fields converted to BN128 field elements (hex/decimal integers reduced mod p; free-form ids SHA-256 hashed first), plus the decision bit; the 13th public signal returned is the Poseidon commitment over the claim id and a private salt. Because this is a public demo, the verification-key fields are both the registered gatekeeper VK hash — the VK-match check is trivially satisfied — and the salt is a **fixed demo derivation** (`SHA-256("receiptguard-salt:" + claim_id) mod p`), so anyone can reproduce a decision byte-for-byte. No secrets are involved anywhere in this service.
- **Pinned circuit artifacts.** The official `gatekeeper.wasm` and `gatekeeper_final.zkey` are copied into `circuits/` and **SHA-256-verified at startup** against the pinned official hashes; a mismatch refuses to run. Proving is serialized through a promise chain so concurrent claims cannot interleave witness generation.
- **Verify before answering.** Every response is produced only after `snarkjs.groth16.verify` succeeds against `circuits/verification_key.json`; the boolean result is returned as `verified`. A proving failure is a 500, never an unproven decision.

## Key design decisions

1. **Prove rejections too.** The valuable property is not "approved payments are proved" but "*decisions* are proved" — a proved rejection settles disputes in the other direction.
2. **Determinism over cleverness.** No model calls, no randomness: same claim in, same decision and same proof inputs out. That is what makes the output auditable.
3. **Public by design.** Unlike a competition endpoint behind HMAC, ReceiptGuard is an open demo: reproducible salt, no secrets, landing page included — a judge (or anyone) can exercise it end-to-end in a browser.
4. **Small and boring stack.** Single-project Node (`node:http` only, snarkjs the sole dependency), deployable as a plain server or as a Vercel serverless function with the included `vercel.json` + `api/check.mjs` layout.

## The zkVerify angle (checkable claim)

**Claim:** for any claim submitted to the live endpoint, the returned `decision` is the unique decision the release rules allow for the returned `public_signals`, and the returned Groth16 proof verifies against the official gatekeeper circuit verification key (VK hash `0x6b79c601…77b0`, artifacts pinned by SHA-256 in the repo).

**Check it yourself:** take any response's `proof` and `public_signals`, run `snarkjs.groth16.verify(circuits/verification_key.json, public_signals, proof)` — or submit the proof to zkVerify for on-chain verification. The 12 field signals decode to the exact claim you submitted, and signal 13 (index 0) is the Poseidon commitment; the decision bit is among the public signals, so a forged or altered decision cannot verify.

## Run it locally

```bash
npm install        # sole dependency: snarkjs
npm start          # http://localhost:8790  (GET / demo, POST /agent)
npm test           # end-to-end tests against a live local instance
```

Tests cover: server startup + health, the landing page, a valid claim → `APPROVE / VALID_CONDITION`, and four rejection shapes (threshold, expiry, amount overflow, recipient mismatch) — every decision asserted to carry a proof with 13 public signals that verifies server-side — plus a malformed-claim case. **23 checks, all passing.**

## Live endpoint

> **Placeholder — filled in at deployment.**
> Public endpoint: `https://aripin98-receiptguard.vercel.app`
> Repository: `https://github.com/aripinoffl/<receiptguard-repo>`

## Layout

```
receiptguard.mjs   policy, circuit-input construction, proving, verification
server.mjs         node:http service (GET /, GET+POST /agent, POST /api/check)
api/check.mjs      Vercel serverless entry (rewrites in vercel.json)
public/index.html  landing page + live try-it form
circuits/          official gatekeeper artifacts (SHA-256 pinned at load)
test.mjs           end-to-end tests (23 checks)
```
