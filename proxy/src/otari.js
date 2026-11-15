/**
 * otari.js — thin wrapper around the Otari management API.
 *
 * Key facts confirmed against the live API (task 2):
 *   - POST /v1/chat/completions with body.user + Otari-End-User-Budget header
 *     auto-creates the per-user record on first request; no pre-registration needed.
 *   - GET /api/v1/end-user-budgets lists budgets attached to this service key.
 *   - GET /api/v1/end-users?external_id=<id> returns live spend.
 *   - PATCH /api/v1/end-users?external_id=<id> {"blocked":true} blocks an origin.
 *   - GET /api/v1/organizations/me/budgets requires a master key (not available on
 *     hosted tier) — use /end-user-budgets instead. Filed as Otari feedback.
 */

const BASE = "https://api.otari.ai/api/v1";

function mgmtHeaders(serviceKey) {
  return { "Otari-Key": serviceKey, "Content-Type": "application/json" };
}

/**
 * Fetch the budget id for a given budget name from this service key's budgets.
 * Throws if the named budget doesn't exist on the key.
 */
export async function resolveBudgetId(serviceKey, budgetName) {
  const resp = await fetch(`${BASE}/end-user-budgets`, {
    headers: mgmtHeaders(serviceKey),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Otari GET /end-user-budgets: ${resp.status} ${txt.slice(0, 200)}`);
  }
  const list = await resp.json();
  const budget = (Array.isArray(list) ? list : list.data ?? [])
    .find((b) => b.name === budgetName);
  if (!budget) throw new Error(`No Otari budget named "${budgetName}" on this service key`);
  return budget.budget_id;
}

/**
 * Get live spend info for one end-user (origin).
 * Returns null if the end-user hasn't made any requests yet.
 */
export async function getEndUser(serviceKey, externalId) {
  const url = `${BASE}/end-users?external_id=${encodeURIComponent(externalId)}`;
  const resp = await fetch(url, { headers: mgmtHeaders(serviceKey) });
  if (!resp.ok) return null;
  const data = await resp.json();
  const records = Array.isArray(data) ? data : (data.data ?? []);
  return records.find((r) => r.external_id === externalId) ?? null;
}

/**
 * Block or unblock an end-user (origin).
 * Used by the admin endpoint to cut off or restore a specific peer.
 */
export async function setEndUserBlocked(serviceKey, externalId, blocked) {
  const url = `${BASE}/end-users?external_id=${encodeURIComponent(externalId)}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: mgmtHeaders(serviceKey),
    body: JSON.stringify({ blocked }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Otari PATCH /end-users: ${resp.status} ${txt.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Assign a different budget to an end-user (origin).
 * Used by the admin endpoint to give a known-good peer a higher ceiling.
 */
export async function setEndUserBudget(serviceKey, externalId, budgetId) {
  const url = `${BASE}/end-users?external_id=${encodeURIComponent(externalId)}`;
  const resp = await fetch(url, {
    method: "PATCH",
    headers: mgmtHeaders(serviceKey),
    body: JSON.stringify({ budget_id: budgetId }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Otari PATCH /end-users budget: ${resp.status} ${txt.slice(0, 200)}`);
  }
  return resp.json();
}
