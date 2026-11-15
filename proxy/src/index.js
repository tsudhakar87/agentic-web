/**
 * Allowance proxy — per-origin spend ceiling for the Open Agentic Web.
 *
 * Sits between the patched runtime (llm.js) and Otari:
 *   browser runtime → POST /v1/chat/completions → THIS PROXY → Otari
 *
 * The patched runtime already sets body.user = origin (peer's window.origin).
 * This proxy adds the Otari-End-User-Budget header and streams the response
 * back verbatim — including Otari's 403 budget_exceeded when the ceiling fires.
 *
 * Env vars (set in .env or platform dashboard):
 *   OTARI_SERVICE_KEY   — service key with allowance-per-origin budget attached
 *   OTARI_BUDGET_NAME   — budget name on that key (default: allowance-per-origin)
 *   PORT                — listen port (default: 3001)
 *   ADMIN_SECRET        — bearer token for /admin/* routes (generate with openssl rand -hex 32)
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { stream } from "hono/streaming";
import { resolveBudgetId, getEndUser, setEndUserBlocked, setEndUserBudget } from "./otari.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVICE_KEY  = process.env.OTARI_SERVICE_KEY;
const BUDGET_NAME  = process.env.OTARI_BUDGET_NAME  || "allowance-per-origin";
const PORT         = parseInt(process.env.PORT || "3001", 10);
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const OTARI_CHAT   = "https://api.otari.ai/api/v1/chat/completions";

if (!SERVICE_KEY) {
  console.error("[allowance-proxy] OTARI_SERVICE_KEY is required");
  process.exit(1);
}

// Resolve budget id once at startup — fail fast if misconfigured.
let BUDGET_ID;
try {
  BUDGET_ID = await resolveBudgetId(SERVICE_KEY, BUDGET_NAME);
  console.log(`[allowance-proxy] budget "${BUDGET_NAME}" = ${BUDGET_ID}`);
} catch (err) {
  console.error(`[allowance-proxy] failed to resolve budget: ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono();

// CORS — required: the runtime runs in a browser and calls this cross-origin.
app.use("*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Otari-End-User-Budget");
  c.header("Access-Control-Expose-Headers", "Otari-End-User-Budget, X-Allowance-Origin");
  if (c.req.method === "OPTIONS") return c.text("", 204);
  await next();
});

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — main proxy route
// ---------------------------------------------------------------------------

app.post("/v1/chat/completions", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const origin = body.user;
  if (!origin) {
    return c.json({ error: "body.user (peer origin) is required" }, 400);
  }

  // Ensure max_tokens has a value (Otari reserves prompt + max_tokens upfront).
  body.max_tokens = body.max_tokens ?? 1024;

  const upstream = await fetch(OTARI_CHAT, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Otari-End-User-Budget": BUDGET_ID,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // Log every request regardless of outcome.
  const logLine = {
    t: new Date().toISOString(),
    origin,
    model: body.model,
    status: upstream.status,
    budget: BUDGET_ID,
  };

  // Pass 403 budget_exceeded back verbatim — the patched runtime handles it.
  if (upstream.status === 403) {
    const errBody = await upstream.json().catch(() => ({}));
    console.log("[proxy]", { ...logLine, exceeded: true, detail: errBody.detail });
    return c.json(errBody, 403, {
      "Otari-End-User-Budget": upstream.headers.get("Otari-End-User-Budget") ?? BUDGET_ID,
      "X-Allowance-Origin": origin,
    });
  }

  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => "");
    console.error("[proxy] upstream error", { ...logLine, body: txt.slice(0, 300) });
    return c.text(txt, upstream.status);
  }

  // Stream the SSE response back to the runtime.
  console.log("[proxy]", logLine);

  return stream(c, async (s) => {
    s.onAbort(() => upstream.body?.cancel());
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let promptTokens = 0;
    let completionTokens = 0;

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = dec.decode(value, { stream: true });
      await s.write(chunk);

      // Best-effort token count from usage chunk (arrives at end of stream).
      for (const line of chunk.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload);
          if (json.usage) {
            promptTokens    = json.usage.prompt_tokens    ?? 0;
            completionTokens = json.usage.completion_tokens ?? 0;
          }
        } catch { /* ignore malformed */ }
      }
    }

    if (promptTokens || completionTokens) {
      console.log("[proxy] usage", { origin, promptTokens, completionTokens });
    }
  }, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Allowance-Origin": origin,
      "Otari-End-User-Budget": BUDGET_ID,
    },
  });
});

// ---------------------------------------------------------------------------
// Admin routes — protected by ADMIN_SECRET bearer token
// ---------------------------------------------------------------------------

function requireAdmin(c) {
  if (!ADMIN_SECRET) return null; // admin disabled
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${ADMIN_SECRET}`) return c.json({ error: "unauthorized" }, 401);
  return null;
}

/** GET /admin/origins/:origin — live spend for one origin */
app.get("/admin/origins/:origin", async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const origin = decodeURIComponent(c.req.param("origin"));
  const user = await getEndUser(SERVICE_KEY, origin);
  if (!user) return c.json({ origin, tracked: false }, 404);
  return c.json({ origin, tracked: true, ...user });
});

/** PATCH /admin/origins/:origin — block, unblock, or reassign budget */
app.patch("/admin/origins/:origin", async (c) => {
  const deny = requireAdmin(c);
  if (deny) return deny;

  const origin = decodeURIComponent(c.req.param("origin"));
  let payload;
  try { payload = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }

  if (typeof payload.blocked === "boolean") {
    const result = await setEndUserBlocked(SERVICE_KEY, origin, payload.blocked);
    console.log(`[admin] origin ${origin} blocked=${payload.blocked}`);
    return c.json(result);
  }

  if (typeof payload.budget_id === "string") {
    const result = await setEndUserBudget(SERVICE_KEY, origin, payload.budget_id);
    console.log(`[admin] origin ${origin} reassigned to budget ${payload.budget_id}`);
    return c.json(result);
  }

  return c.json({ error: "provide blocked (bool) or budget_id (string)" }, 400);
});

/** GET /health */
app.get("/health", (c) =>
  c.json({ ok: true, budget: BUDGET_ID, budgetName: BUDGET_NAME })
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[allowance-proxy] listening on http://localhost:${PORT}`);
  if (!ADMIN_SECRET) console.warn("[allowance-proxy] ADMIN_SECRET not set — admin routes are disabled");
});
