/**
 * Task 2 — Otari live API smoke test
 *
 * Verifies against the real Otari API (no mocks):
 *   1. Fetch the "allowance-test" budget id via the service key's own budget list
 *   2. Chat completion with user + Otari-End-User-Budget header → 200
 *   3. End-user record is visible via management API (using service key)
 *   4. Second request → 403 budget_exceeded  (budget must have request_limit: 1)
 *
 * Usage:
 *   OTARI_SERVICE_KEY=<service key>  node tests/otari_live.mjs
 *
 * Optional overrides:
 *   OTARI_BUDGET_NAME=allowance-test          (default)
 *   OTARI_END_USER=https://smoke-test.example (stable per-origin id)
 *   OTARI_MODEL=openai/gpt-4o-mini            (default)
 */

const BASE     = "https://api.otari.ai/api";
const CHAT_URL = `${BASE}/v1/chat/completions`;
const MGMT     = `${BASE}/v1`;

const SERVICE_KEY  = process.env.OTARI_SERVICE_KEY;
const BUDGET_NAME  = process.env.OTARI_BUDGET_NAME || "allowance-test";
const END_USER     = process.env.OTARI_END_USER    || "https://smoke-test.example";
const MODEL        = process.env.OTARI_MODEL       || "openai/gpt-4o-mini";

if (!SERVICE_KEY) {
  console.error("Set OTARI_SERVICE_KEY before running.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Management endpoints: Otari-Key header (no Bearer)
function mgmtHeaders() {
  return { "Otari-Key": SERVICE_KEY, "Content-Type": "application/json" };
}

// Chat completions: standard Bearer + budget header
function chatHeaders(budgetId) {
  return {
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Otari-End-User-Budget": budgetId,
    "Content-Type": "application/json",
  };
}

function pass(msg)    { console.log(`  ✓  ${msg}`); }
function fail(msg)    { console.error(`  ✗  ${msg}`); process.exitCode = 1; }
function section(msg) { console.log(`\n── ${msg}`); }

// ---------------------------------------------------------------------------
// Step 1 — look up the budget id
// ---------------------------------------------------------------------------

section("Step 1 — look up budget id via service key");

const budgetsResp = await fetch(`${MGMT}/end-user-budgets`, { headers: mgmtHeaders() });

if (!budgetsResp.ok) {
  const txt = await budgetsResp.text().catch(() => "");
  fail(`GET /end-user-budgets: HTTP ${budgetsResp.status} — ${txt.slice(0, 300)}`);
  process.exit(1);
}

const budgetList = await budgetsResp.json();
const list = Array.isArray(budgetList) ? budgetList : (budgetList.data ?? []);
console.log(`   Service key has ${list.length} end-user budget(s)`);
list.forEach((b) => console.log(`     - "${b.name}"  id=${b.budget_id}  request_limit=${b.request_limit}`));

const budget = list.find((b) => b.name === BUDGET_NAME);
if (!budget) {
  fail(`No budget named "${BUDGET_NAME}" on this service key.`);
  process.exit(1);
}

const BUDGET_ID = budget.budget_id;
pass(`Budget "${BUDGET_NAME}" id = ${BUDGET_ID}`);

if (budget.request_limit !== 1) {
  console.warn(`   ⚠ request_limit=${budget.request_limit} (not 1) — step 4 may not 403 on the 2nd request`);
}

// ---------------------------------------------------------------------------
// Step 2 — first chat completion (expect 200)
// ---------------------------------------------------------------------------

section("Step 2 — first chat completion (expect 200)");

const chatBody = {
  model: MODEL,
  user: END_USER,
  max_tokens: 16,
  messages: [{ role: "user", content: "Reply with the single word: acknowledged" }],
};

const resp1 = await fetch(CHAT_URL, {
  method: "POST",
  headers: chatHeaders(BUDGET_ID),
  body: JSON.stringify(chatBody),
});

const body1txt = await resp1.text().catch(() => "");

if (!resp1.ok) {
  fail(`Expected 200, got ${resp1.status}: ${body1txt.slice(0, 400)}`);
  process.exit(1);
}

const data1 = JSON.parse(body1txt);
pass(`HTTP ${resp1.status} — model: ${data1.model ?? "?"}`);
pass(`Content: "${(data1.choices?.[0]?.message?.content ?? "").slice(0, 80)}"`);

const budgetHeader1 = resp1.headers.get("Otari-End-User-Budget");
if (budgetHeader1) pass(`Otari-End-User-Budget response header = ${budgetHeader1}`);

// ---------------------------------------------------------------------------
// Step 3 — verify end-user record in management API
// ---------------------------------------------------------------------------

section("Step 3 — verify end-user is tracked");

const euResp = await fetch(
  `${MGMT}/end-users?external_id=${encodeURIComponent(END_USER)}`,
  { headers: mgmtHeaders() },
);

let endUserFound = false;
if (euResp.ok) {
  const eu = await euResp.json();
  const records = Array.isArray(eu) ? eu : (eu.data ?? [eu]);
  const match = records.find((r) => r?.external_id === END_USER);
  if (match) {
    pass(`End-user found — user_id=${match.user_id ?? "?"}  spend=${match.spend ?? "?"}  requests=${match.current_requests ?? "?"}`);
    endUserFound = true;
  } else {
    console.warn(`   Not found by external_id. Response: ${JSON.stringify(eu).slice(0, 200)}`);
  }
} else {
  const txt = await euResp.text().catch(() => "");
  console.warn(`   GET /end-users: HTTP ${euResp.status} — ${txt.slice(0, 200)}`);
  console.warn("   (note for proxy design: end-user read may require a different key type)");
}

// ---------------------------------------------------------------------------
// Step 4 — second request should be refused (request_limit: 1)
// ---------------------------------------------------------------------------

section("Step 4 — second request (expect 403 budget_exceeded)");

const resp2 = await fetch(CHAT_URL, {
  method: "POST",
  headers: chatHeaders(BUDGET_ID),
  body: JSON.stringify(chatBody),
});

const body2 = await resp2.text().catch(() => "");

if (resp2.status === 403) {
  pass(`HTTP 403 — budget ceiling enforced`);

  // Log the full error shape for proxy design
  try {
    const err = JSON.parse(body2);
    console.log("   Error JSON:", JSON.stringify(err, null, 2).replace(/^/gm, "   "));
  } catch {
    console.log(`   Error body (plain text): ${body2.slice(0, 300)}`);
  }

  const refusalHeader = resp2.headers.get("Otari-End-User-Budget");
  if (refusalHeader) pass(`Otari-End-User-Budget on refusal = ${refusalHeader}`);
} else if (resp2.status === 200) {
  console.warn("   Got 200 — budget may not have request_limit:1.");
  console.warn("   Set the budget's request limit to 1 in the Otari dashboard and re-run.");
} else {
  fail(`Unexpected status ${resp2.status}: ${body2.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

section("Summary");
console.log(`   Budget id            : ${BUDGET_ID}`);
console.log(`   End-user id          : ${END_USER}`);
console.log(`   First request (200)  : ${resp1.status === 200}`);
console.log(`   End-user tracked     : ${endUserFound}`);
console.log(`   Ceiling enforced 403 : ${resp2.status === 403}`);

const allGood = resp1.status === 200 && resp2.status === 403;
console.log(allGood
  ? "\n   ✓ Otari live API matches docs — proxy design is sound."
  : "\n   ⚠ Some checks incomplete — see warnings above before finalising proxy design."
);
