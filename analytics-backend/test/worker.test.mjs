import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import worker, { filters, maskIp, csvCell, tokyoDate } from "../src/worker.js";

const token = "a".repeat(43);
const origin = "https://nero-kong.github.io";
const endpoint = "https://analytics.example";

class D1 {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../migrations/0001_visits.sql", import.meta.url), "utf8"));
  }
  prepare(sql) {
    const db = this.db;
    let values = [];
    return {
      bind(...parameters) { values = parameters; return this; },
      async all() { return { results: db.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: Number(db.prepare(sql).run(...values).changes) } }; }
    };
  }
  async batch(statements) { return Promise.all(statements.map(statement => statement.all())); }
}

function fixture() {
  return { DB: new D1(), ADMIN_TOKEN: token, ALLOWED_ORIGINS: origin,
    ASSETS: { fetch: async () => new Response("<!doctype html><title>Admin</title>", { headers: { "Content-Type": "text/html" } }) } };
}

function request(path, options = {}, cf = {}) {
  const req = new Request(endpoint + path, options);
  Object.defineProperty(req, "cf", { value: cf });
  return req;
}

function visitRequest(body = {}, headers = {}, cf = {}) {
  return request("/collect", { method: "POST", headers: {
    Origin: origin, "CF-Connecting-IP": "203.0.113.10", "User-Agent": "Mozilla/5.0 TestBrowser",
    "Content-Type": "text/plain", ...headers
  }, body: JSON.stringify({ eventId: crypto.randomUUID(), path: "/", ...body }) }, cf);
}

async function api(env, path = "/api/visits", options = {}) {
  return worker.fetch(request(path, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } }), env);
}

async function record(env, extra = {}, headers = {}, cf = {}) {
  assert.equal((await worker.fetch(visitRequest(extra, headers, cf), env)).status, 204);
}

test("unknown origins and missing origins cannot collect or receive CORS access", async () => {
  const env = fixture();
  const response = await worker.fetch(visitRequest({}, { Origin: "https://evil.example" }), env);
  assert.equal(response.status, 403); assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
  const noOrigin = visitRequest(); noOrigin.headers.delete("Origin");
  assert.equal((await worker.fetch(noOrigin, env)).status, 403);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM visits").get().n, 0);
});

test("all visit/summary/export/deletion APIs require authentication", async () => {
  const env = fixture(); await record(env);
  for (const path of ["/api/visits", "/api/summary", "/api/export"]) {
    const response = await worker.fetch(request(path), env);
    assert.equal(response.status, 401); assert.ok(!(await response.text()).includes("203.0.113.10"));
  }
  assert.equal((await worker.fetch(request("/api/visits", { method: "DELETE" }), env)).status, 401);
  assert.equal((await api(env, "/api/visits", { headers: { Authorization: `Bearer ${"b".repeat(43)}` } })).status, 401);
});

test("production collection stays unavailable without a strong admin secret", async () => {
  const env = fixture(); env.ADMIN_TOKEN = "short";
  assert.equal((await worker.fetch(visitRequest(), env)).status, 503);
  assert.equal((await worker.fetch(request("/health"), env)).status, 503);
});

test("ordinary visits need no consent field; known pages and UUIDs are required", async () => {
  const env = fixture();
  await record(env);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM visits").get().n, 1);
  for (const body of [{ eventId: "fake" }, { path: "/?secret=1" }, { path: "/privacy.html" }, { path: "/other.html" }]) {
    assert.equal((await worker.fetch(visitRequest(body), env)).status, 400);
  }
});

test("DNT and GPC headers do not gate automatic collection", async () => {
  const env = fixture();
  for (const headers of [{ "Sec-GPC": "1" }, { DNT: "1" }, { "Sec-GPC": "1", DNT: "1" }]) {
    await record(env, {}, headers);
  }
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM visits").get().n, 3);
});

test("bot agents and owner-excluded IPs suppress collection", async () => {
  const env = fixture();
  await record(env, {}, { "User-Agent": "Googlebot" });
  env.EXCLUDED_IPS = "203.0.113.10"; await record(env);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM visits").get().n, 0);
});

test("real connection metadata wins over client claims and events deduplicate", async () => {
  const env = fixture(); const id = crypto.randomUUID();
  const body = { eventId: id, path: "/index.html", ip: "198.51.100.2", country: "US", visited_at: 1,
    referrerHost: "search.example" };
  const cf = { country: "JP", region: "Tokyo", city: "Bunkyo", asOrganization: "Example University", asn: 64500 };
  await record(env, body, {}, cf); await record(env, body, {}, cf);
  const rows = env.DB.db.prepare("SELECT * FROM visits").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].ip, "203.0.113.10"); assert.equal(rows[0].country, "JP");
  assert.equal(rows[0].network, "Example University"); assert.equal(rows[0].path, "/");
  assert.ok(rows[0].visited_at > 1); assert.equal(rows[0].referrer_host, "search.example");
});

test("bad JSON, oversized bodies and invalid referrers are rejected", async () => {
  const env = fixture();
  const req = visitRequest();
  const malformed = new Request(req.url, { method: "POST", headers: req.headers, body: "{" });
  assert.equal((await worker.fetch(malformed, env)).status, 400);
  assert.equal((await worker.fetch(visitRequest({ filler: "x".repeat(3000) }), env)).status, 413);
  assert.equal((await worker.fetch(visitRequest({ referrerHost: "https://other.example/?token=abc" }), env)).status, 400);
});

test("limits and unexpected failures do not disclose internals", async () => {
  const env = fixture(); env.COLLECT_LIMITER = { limit: async () => ({ success: false }) };
  assert.equal((await worker.fetch(visitRequest(), env)).status, 429);
  env.COLLECT_LIMITER = null; env.DB = { prepare() { throw new Error("database password is secret"); } };
  const response = await worker.fetch(visitRequest(), env);
  assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("secret"));
});

test("IPs are masked unless explicitly requested by an authenticated viewer", async () => {
  const env = fixture(); await record(env);
  const masked = await (await api(env)).json(); assert.equal(masked.visits[0].ip, "203.0.113.*");
  const full = await (await api(env, "/api/visits?reveal=1")).json(); assert.equal(full.visits[0].ip, "203.0.113.10");
  assert.equal(maskIp("2001:db8::1234"), "2001:db8:*");
});

test("filters are bound parameters, respect JST, and validate dates", async () => {
  const env = fixture(); await record(env, {}, {}, { country: "JP", asOrganization: "Example Network" });
  assert.equal((await (await api(env, "/api/visits?country=JP&path=%2F&search=Example")).json()).visits.length, 1);
  assert.equal((await (await api(env, "/api/visits?search=%27%20OR%201%3D1--")).json()).visits.length, 0);
  assert.equal((await (await api(env, "/api/visits?search=%25")).json()).visits.length, 0);
  for (const query of ["from=2026-02-30", "country=JPN", "path=%2Funknown", "offset=bad", "from=2026-10-04&to=2026-10-02", "allTime=yes"]) {
    assert.equal((await api(env, `/api/visits?${query}`)).status, 400);
  }
  const range = filters(new URLSearchParams("from=2026-10-03&to=2026-10-03"), Date.parse("2026-10-03T00:00:00Z"));
  assert.equal(range.values[0], Date.parse("2026-10-02T15:00:00Z"));
  assert.equal(range.values[1], Date.parse("2026-10-03T15:00:00Z"));
  assert.equal(tokyoDate(Date.parse("2026-10-02T16:00:00Z")), "2026-10-03");
});

test("pagination and summaries return counts without raw IPs", async () => {
  const env = fixture();
  for (let i = 0; i < 52; i++) await record(env, {}, {}, { country: "JP" });
  const summary = await (await api(env, "/api/summary")).json();
  assert.equal(summary.visits, 52); assert.equal(summary.unique_ips, 1); assert.equal(summary.countries, 1);
  assert.ok(!JSON.stringify(summary).includes("203.0.113.10"));
  const page = await (await api(env)).json(); assert.equal(page.visits.length, 50); assert.equal(page.hasMore, true);
  const next = await (await api(env, "/api/visits?offset=50")).json(); assert.equal(next.visits.length, 2); assert.equal(next.hasMore, false);
});

test("CSV is private, masked by default and escaped against spreadsheet formulas", async () => {
  const env = fixture(); await record(env, {}, {}, { asOrganization: "=HYPERLINK(\"bad\")" });
  const response = await api(env, "/api/export"); const csv = await response.text();
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.ok(csv.includes("203.0.113.*")); assert.ok(!csv.includes("203.0.113.10"));
  assert.ok(csv.includes("'=HYPERLINK")); assert.equal(csvCell('a"b'), '"a""b"');
  assert.ok((await (await api(env, "/api/export?reveal=1")).text()).includes("203.0.113.10"));
});

test("old records remain queryable, exportable and deletable without any retention cutoff", async () => {
  const env = fixture(); await record(env);
  const oldTime = Date.now() - 400 * 86400000;
  env.DB.db.prepare("UPDATE visits SET visited_at = ?").run(oldTime);
  assert.equal((await (await api(env)).json()).visits.length, 0);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM visits").get().n, 1);
  const range = `/api/visits?from=${tokyoDate(oldTime)}&to=${tokyoDate(Date.now())}`;
  assert.equal((await (await api(env, range)).json()).visits.length, 1);
  assert.equal((await (await api(env, "/api/visits?allTime=1")).json()).visits.length, 1);
  assert.equal((await (await api(env, "/api/visits?allTime=1&country=US")).json()).visits.length, 0);
  const summary = await (await api(env, "/api/summary?allTime=1")).json();
  assert.equal(summary.visits, 1); assert.equal(summary.retentionDays, null); assert.equal(summary.autoDeletion, false);
  assert.equal(summary.from, null); assert.equal(summary.to, null);
  const exported = await api(env, "/api/export?allTime=1");
  assert.ok(exported.headers.get("Content-Disposition").includes("visits-all-dates.csv"));
  assert.ok((await exported.text()).includes(tokyoDate(oldTime)));
  assert.equal(typeof worker.scheduled, "undefined");
  const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(config.triggers.crons, []);
  const deleted = await api(env, "/api/visits?allTime=1", { method: "DELETE", body: JSON.stringify({ confirm: "delete-filtered" }) });
  assert.equal((await deleted.json()).deleted, 1);
  assert.equal(env.DB.db.prepare("SELECT COUNT(*) AS n FROM visits").get().n, 0);
});

test("deletion requires confirmation and same-origin, and only removes matching records", async () => {
  const env = fixture(); await record(env, {}, {}, { country: "JP" }); await record(env, {}, {}, { country: "US" });
  const options = { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "delete-filtered" }) };
  assert.equal((await api(env, "/api/visits?country=JP", { ...options, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await api(env, "/api/visits?country=JP", { ...options, body: "{}" })).status, 400);
  const response = await api(env, "/api/visits?country=JP", options);
  assert.equal((await response.json()).deleted, 1);
  assert.equal((await (await api(env)).json()).visits[0].country, "US");
});

test("production HTTP requests redirect to HTTPS while localhost previews stay available", async () => {
  const env = fixture();
  for (const path of ["/admin", "/api/summary", "/collect", "/health"]) {
    const response = await worker.fetch(new Request(`http://analytics.example${path}`), env);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get("Location"), `https://analytics.example${path}`);
  }
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const response = await worker.fetch(new Request(`http://${host}:8788/admin`), env);
    assert.equal(response.status, 200);
  }
});

test("dashboard is public login-only HTML with CSP, frame and cache protection", async () => {
  const env = fixture();
  const response = await worker.fetch(request("/admin"), env);
  assert.equal(response.status, 200); assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.ok(response.headers.get("Content-Security-Policy").includes("script-src 'self'"));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal((await worker.fetch(request("/.production.vars"), env)).status, 404);
});
