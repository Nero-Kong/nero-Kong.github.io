import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

const DAY = 86400000;
const PAGES = new Set(["/", "/index.html", "/project.html", "/panosomafly.html", "/crop-ar.html"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...SECURITY_HEADERS, "Content-Type": "application/json;charset=UTF-8" }
  });
}

function ready(env) {
  return Boolean(env.DB && typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length >= 32);
}

function origins(env) {
  return (env.ALLOWED_ORIGINS || "").split(",").map(item => item.trim()).filter(Boolean);
}

function cors(response, origin) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

async function limit(binding, key) {
  if (binding && !(await binding.limit({ key })).success) throw new HttpError(429, "Too many requests. Try again later.");
}

async function readJson(request) {
  if (Number(request.headers.get("Content-Length")) > 2048) throw new HttpError(413, "Request too large.");
  if (!request.body) throw new HttpError(400, "Missing request body.");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); throw new HttpError(413, "Request too large."); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (_) { throw new HttpError(400, "Invalid JSON."); }
}

function text(value, max = 100) {
  return typeof value === "string" ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max) : null;
}

async function collect(request, env) {
  if (request.method !== "POST") throw new HttpError(405, "POST required.");
  if (!ready(env)) throw new HttpError(503, "Analytics is not configured.");
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || !isIP(ip)) throw new HttpError(400, "Missing valid client IP.");
  await limit(env.COLLECT_LIMITER, ip);
  const body = await readJson(request);
  if (!UUID.test(body.eventId || "") || !PAGES.has(body.path)) throw new HttpError(400, "Invalid visit.");
  const agent = request.headers.get("User-Agent") || "";
  if (/bot\b|crawler|spider|headless|preview|slurp|facebookexternalhit/i.test(agent)) return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  const excluded = (env.EXCLUDED_IPS || "").split(",").map(item => item.trim());
  if (excluded.includes(ip)) return new Response(null, { status: 204, headers: SECURITY_HEADERS });
  const cf = request.cf || {};
  const referrer = text(body.referrerHost, 253);
  if (referrer && !/^[a-z0-9.-]+$/i.test(referrer)) throw new HttpError(400, "Invalid referrer hostname.");
  await env.DB.prepare(`INSERT OR IGNORE INTO visits
    (event_id, visited_at, ip, country, region, city, network, asn, path, referrer_host)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(body.eventId, Date.now(), ip.toLowerCase(), text(cf.country, 2), text(cf.region), text(cf.city),
      text(cf.asOrganization, 200), Number.isInteger(cf.asn) ? cf.asn : null,
      body.path === "/index.html" ? "/" : body.path, referrer || null).run();
  return new Response(null, { status: 204, headers: SECURITY_HEADERS });
}

async function authorize(request, env) {
  if (!ready(env)) throw new HttpError(503, "Analytics is not configured.");
  const provided = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
  if (!provided) throw new HttpError(401, "Invalid access key.");
  const encoder = new TextEncoder();
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_TOKEN)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided))
  ]);
  if (!timingSafeEqual(new Uint8Array(expected), new Uint8Array(actual))) {
    await limit(env.ADMIN_LIMITER, request.headers.get("CF-Connecting-IP") || "unknown");
    throw new HttpError(401, "Invalid access key.");
  }
}

export function tokyoDate(timestamp) {
  return new Date(timestamp + 9 * 3600000).toISOString().slice(0, 10);
}

function dateStart(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new HttpError(400, "Invalid date.");
  const date = Date.parse(`${value}T00:00:00+09:00`);
  if (!Number.isFinite(date) || tokyoDate(date) !== value) throw new HttpError(400, "Invalid date.");
  return date;
}

export function filters(params, now = Date.now()) {
  const allTime = params.get("allTime");
  if (allTime !== null && allTime !== "1") throw new HttpError(400, "Invalid date range mode.");
  const from = allTime === "1" ? null : params.get("from") || tokyoDate(now - 6 * DAY);
  const to = allTime === "1" ? null : params.get("to") || tokyoDate(now);
  const conditions = [];
  const values = [];
  if (from !== null) {
    const start = dateStart(from);
    const end = dateStart(to) + DAY;
    if (end <= start) throw new HttpError(400, "End date must not precede start date.");
    conditions.push("visited_at >= ?", "visited_at < ?");
    values.push(start, end);
  }
  const country = params.get("country") || "";
  if (country && !/^[A-Z]{2}$/.test(country)) throw new HttpError(400, "Invalid country code.");
  if (country) { conditions.push("country = ?"); values.push(country); }
  const path = params.get("path") || "";
  if (path && !PAGES.has(path)) throw new HttpError(400, "Invalid page.");
  if (path) { conditions.push("path = ?"); values.push(path === "/index.html" ? "/" : path); }
  const search = params.get("search") || "";
  if (search.length > 100) throw new HttpError(400, "Search is too long.");
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    conditions.push("(ip LIKE ? ESCAPE '\\' OR network LIKE ? ESCAPE '\\' OR city LIKE ? ESCAPE '\\')");
    values.push(like, like, like);
  }
  return { where: conditions.length ? conditions.join(" AND ") : "1 = 1", values, from, to };
}

export function maskIp(ip) {
  if (isIP(ip) === 4) return ip.split(".").slice(0, 3).join(".") + ".*";
  if (isIP(ip) === 6) return ip.split(":").slice(0, 2).join(":") + ":*";
  return "unknown";
}

export function csvCell(value) {
  let result = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(result) || /^[\t\r\n]/.test(result)) result = "'" + result;
  return '"' + result.replace(/"/g, '""') + '"';
}

async function adminApi(request, env, url) {
  await authorize(request, env);
  const selected = filters(url.searchParams);
  const query = (sql, extra = []) => env.DB.prepare(sql).bind(...selected.values, ...extra);
  const reveal = url.searchParams.get("reveal") === "1";
  if (url.pathname === "/api/summary" && request.method === "GET") {
    const results = await env.DB.batch([
      query(`SELECT COUNT(*) AS visits, COUNT(DISTINCT ip) AS unique_ips, COUNT(DISTINCT country) AS countries FROM visits WHERE ${selected.where}`),
      query(`SELECT country, COUNT(*) AS visits FROM visits WHERE ${selected.where} GROUP BY country ORDER BY visits DESC LIMIT 8`),
      query(`SELECT path, COUNT(*) AS visits FROM visits WHERE ${selected.where} GROUP BY path ORDER BY visits DESC`)
    ]);
    return json({ ...results[0].results[0], topCountries: results[1].results, pages: results[2].results,
      retentionDays: null, autoDeletion: false, from: selected.from, to: selected.to });
  }
  if (url.pathname === "/api/visits" && request.method === "GET") {
    const rawOffset = url.searchParams.get("offset") || "0";
    if (!/^\d{1,6}$/.test(rawOffset)) throw new HttpError(400, "Invalid offset.");
    const offset = Number(rawOffset);
    const { results } = await query(`SELECT * FROM visits WHERE ${selected.where} ORDER BY visited_at DESC, event_id DESC LIMIT 51 OFFSET ?`, [offset]).all();
    return json({ visits: results.slice(0, 50).map(row => ({ ...row, ip: reveal ? row.ip : maskIp(row.ip) })),
      hasMore: results.length > 50, offset });
  }
  if (url.pathname === "/api/export" && request.method === "GET") {
    const { results } = await query(`SELECT * FROM visits WHERE ${selected.where} ORDER BY visited_at DESC, event_id DESC LIMIT 10001`).all();
    if (results.length > 10000) throw new HttpError(400, "More than 10,000 records. Narrow the filters before exporting.");
    const columns = ["date_time_jst", "ip", "country", "region", "city", "network", "asn", "page", "referrer_host"];
    const lines = results.map(row => [new Date(row.visited_at + 9 * 3600000).toISOString().replace("T", " ").replace("Z", " +09:00"),
      reveal ? row.ip : maskIp(row.ip), row.country, row.region, row.city, row.network, row.asn, row.path, row.referrer_host].map(csvCell).join(","));
    return new Response("\uFEFF" + [columns.join(","), ...lines].join("\r\n"), {
      headers: { ...SECURITY_HEADERS, "Content-Type": "text/csv;charset=UTF-8",
        "Content-Disposition": `attachment; filename="visits-${selected.from || "all"}-${selected.to || "dates"}.csv"` }
    });
  }
  if (url.pathname === "/api/visits" && request.method === "DELETE") {
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) throw new HttpError(403, "Same-origin request required.");
    const body = await readJson(request);
    if (body.confirm !== "delete-filtered") throw new HttpError(400, "Deletion confirmation required.");
    const result = await query(`DELETE FROM visits WHERE ${selected.where}`).run();
    return json({ deleted: result.meta.changes });
  }
  throw new HttpError(404, "Not found.");
}

async function serve(request, env) {
  const url = new URL(request.url);
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.protocol = "https:";
    return Response.redirect(url, 308);
  }
  if (url.pathname === "/collect") {
    const origin = request.headers.get("Origin");
    if (!origin || !origins(env).includes(origin)) throw new HttpError(403, "Origin not allowed.");
    if (request.method === "OPTIONS") {
      return cors(new Response(null, { status: 204, headers: { ...SECURITY_HEADERS,
        "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "3600" } }), origin);
    }
    try { return cors(await collect(request, env), origin); }
    catch (error) { return cors(errorResponse(error), origin); }
  }
  if (url.pathname.startsWith("/api/")) return adminApi(request, env, url);
  if (url.pathname === "/health" && request.method === "GET") {
    if (!ready(env)) return json({ ready: false }, 503);
    await env.DB.prepare("SELECT event_id FROM visits LIMIT 1").all();
    return json({ ready: true });
  }
  if (!["GET", "HEAD"].includes(request.method)) throw new HttpError(405, "Method not allowed.");
  if (url.pathname === "/") return Response.redirect(new URL("/admin", url), 302);
  if (["/admin", "/admin/"].includes(url.pathname)) url.pathname = "/index.html";
  if (!["/index.html", "/admin.js", "/admin.css", "/icons.js"].includes(url.pathname)) throw new HttpError(404, "Not found.");
  const asset = await env.ASSETS.fetch(new Request(url, request));
  const headers = new Headers(asset.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  return new Response(asset.body, { status: asset.status, headers });
}

function errorResponse(error) {
  return json({ error: error instanceof HttpError ? error.message : "Service unavailable. Please try again later." }, error instanceof HttpError ? error.status : 503);
}

export default {
  async fetch(request, env) {
    try { return await serve(request, env); } catch (error) { return errorResponse(error); }
  }
};
