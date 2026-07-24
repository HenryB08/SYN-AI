/* Seed script for syn-growth — creates one test tenant, brand, and install end to end,
 * then sets a job value and writes one event through the public path. Run it against a
 * DEPLOYED syn-growth Worker (this cannot run in the no-network sandbox).
 *
 * Usage:
 *   SYN_GROWTH_URL="https://syn-growth.<subdomain>.workers.dev" \
 *   GROWTH_ADMIN_KEY="<the admin secret you set>" \
 *   ORIGIN="https://a-test-client.example.com" \
 *   node worker/seed-syn-growth.mjs
 *
 * The same tenant→brand→install→job-value→event flow is exercised against real SQL by
 * worker/syn-growth.test.mjs, so this script's logic is already verified offline.
 */
const BASE = process.env.SYN_GROWTH_URL;
const ADMIN = process.env.GROWTH_ADMIN_KEY;
const ORIGIN = process.env.ORIGIN || "https://demo-client.example.com";
if (!BASE || !ADMIN){ console.error("Set SYN_GROWTH_URL and GROWTH_ADMIN_KEY."); process.exit(2); }

const adminHeaders = { "Content-Type": "application/json", "Authorization": "Bearer " + ADMIN };
async function admin(method, path, body){
  const r = await fetch(BASE + path, { method, headers: adminHeaders, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok){ throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`); }
  return j;
}

const stamp = Date.now().toString(36);
console.log("Seeding syn-growth at", BASE);

const { tenant } = await admin("POST", "/admin/tenants", {
  name: "Seed Co " + stamp, slug: "seed-co-" + stamp, timezone: "America/New_York", plan: "core", notes: "seed script",
});
console.log("tenant:", tenant.id, tenant.slug);

const { brand } = await admin("POST", `/admin/tenants/${tenant.id}/brands`, {
  name: "Seed Co", profile: {
    voice: "friendly, direct, no jargon",
    services: ["consultation", "installation", "service call"],
    approved_claims: ["Licensed and insured", "Same-week appointments"],
    banned_claims: ["cheapest in town", "guaranteed results"],
    legal_guardrails: ["Never quote a firm price without a site visit."],
    tone_rules: ["Warm but concise. No exclamation spam."],
    faq: [{ q: "Do you offer free estimates?", a: "Yes, for standard jobs." }],
    escalation_rules: ["If the visitor is upset or asks for a human, escalate."],
  },
});
console.log("brand:", brand.id);

const { install } = await admin("POST", `/admin/tenants/${tenant.id}/installs`, {
  brand_id: brand.id, allowed_origins: [ORIGIN], config: { greeting: "Hi! How can we help?", accent: "#111111" },
});
console.log("install:", install.id);
console.log("INSTALL KEY (public — goes in the client's <script>, shown once):", install.install_key);

const { job_value } = await admin("POST", `/admin/tenants/${tenant.id}/job-value`, {
  average_job_value_cents: 35000, set_by: "seed-script", note: "initial average job value",
});
console.log("job_value:", job_value.id, "$" + (job_value.average_job_value_cents / 100).toFixed(2));

// Public write path (install key + origin), the way the widget will call it.
const evRes = await fetch(BASE + "/w/events?k=" + encodeURIComponent(install.install_key), {
  method: "POST", headers: { "Content-Type": "application/json", "Origin": ORIGIN },
  body: JSON.stringify({ type: "inquiry_received", payload: { note: "seed inquiry" }, idempotency_key: "seed-" + stamp }),
});
console.log("public /w/events →", evRes.status, await evRes.text());

console.log("\n✔ Seed complete. Tenant, brand, and install are live; one job value and one event recorded.");
