import { icons } from "/icons.js";

const $ = id => document.getElementById(id);
for (const element of document.querySelectorAll("[data-icon]")) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [key, value] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(key, value);
  for (const [tag, attributes] of icons[element.dataset.icon] || []) {
    const node = document.createElementNS(svg.namespaceURI, tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
    svg.append(node);
  }
  element.replaceWith(svg);
}

let accessKey = "";
let offset = 0;
let activeFilters;
let controller;
let total = 0;
const pageNames = { "/": "Home", "/project.html": "AdaptiveFly", "/panosomafly.html": "PanoSomaFly", "/crop-ar.html": "Crop AR" };
const dateTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "medium", hour12: false });
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const date = milliseconds => new Date(milliseconds + 9 * 3600000).toISOString().slice(0, 10);
$("from").value = date(Date.now() - 6 * 86400000);
$("to").value = date(Date.now());

function currentFilters() {
  const params = new URLSearchParams(new FormData($("filters")));
  if ($("date-range").value === "all") params.set("allTime", "1");
  params.set("country", params.get("country").trim().toUpperCase());
  params.set("search", params.get("search").trim());
  return params;
}

function params() {
  const values = new URLSearchParams(activeFilters || currentFilters());
  if ($("reveal").checked) values.set("reveal", "1");
  return values;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, cache: "no-store", credentials: "omit",
    headers: { Authorization: `Bearer ${accessKey}`, ...options.headers } });
  if (!response.ok) {
    const message = (await response.json().catch(() => ({}))).error || "Request failed.";
    if (response.status === 401 && !$("dashboard").hidden) signOut();
    throw new Error(message);
  }
  return response;
}

function countryLabel(code) {
  if (!code) return "Unknown";
  try { return countryNames.of(code); } catch (_) { return code; }
}

function breakdown(target, values, label) {
  target.replaceChildren();
  const max = Math.max(1, ...values.map(row => row.visits));
  if (!values.length) {
    const empty = document.createElement("li"); empty.textContent = "No records"; target.append(empty);
  }
  for (const row of values) {
    const item = document.createElement("li");
    const name = document.createElement("span"); name.textContent = label(row);
    const progress = document.createElement("progress"); progress.value = row.visits; progress.max = max;
    progress.setAttribute("aria-label", `${name.textContent}: ${row.visits}`);
    const count = document.createElement("span"); count.className = "count"; count.textContent = row.visits.toLocaleString();
    item.append(name, progress, count); target.append(item);
  }
}

function emptyRow(message) {
  const row = document.createElement("tr");
  const cell = document.createElement("td"); cell.colSpan = 7; cell.className = "empty"; cell.textContent = message;
  row.append(cell); $("visits").replaceChildren(row);
}

function renderVisits(data) {
  $("visits").replaceChildren();
  if (!data.visits.length) emptyRow("No visits in this date range");
  for (const visit of data.visits) {
    const row = document.createElement("tr");
    const values = [dateTime.format(visit.visited_at), visit.ip, visit.country || "Unknown",
      [visit.region || "", visit.city || ""], [visit.network || "Unknown", visit.asn == null ? "" : `AS${visit.asn}`],
      pageNames[visit.path] || visit.path, visit.referrer_host || "Direct / unknown"];
    values.forEach((value, index) => {
      const cell = document.createElement("td");
      if (index <= 1) cell.className = "mono";
      if (Array.isArray(value)) {
        cell.textContent = value[0] || "Unknown";
        const second = document.createElement("span"); second.className = "secondary"; second.textContent = value[1]; cell.append(second);
      } else cell.textContent = value;
      row.append(cell);
    });
    $("visits").append(row);
  }
  $("previous").disabled = offset === 0;
  $("next").disabled = !data.hasMore;
  $("page-status").textContent = data.visits.length ? `${offset + 1}-${offset + data.visits.length} of ${total.toLocaleString()}` : "No records";
}

async function load() {
  controller?.abort();
  const active = new AbortController(); controller = active;
  $("dashboard-error").textContent = "";
  emptyRow("Loading...");
  $("previous").disabled = $("next").disabled = true;
  for (const id of ["export", "delete"]) $(id).disabled = true;
  const query = params(); query.set("offset", String(offset));
  try {
    const [summary, visits] = await Promise.all([
      api(`/api/summary?${query}`, { signal: active.signal }).then(response => response.json()),
      api(`/api/visits?${query}`, { signal: active.signal }).then(response => response.json())
    ]);
    if (active.signal.aborted) return;
    total = summary.visits;
    $("metric-visits").textContent = total.toLocaleString();
    $("metric-ips").textContent = summary.unique_ips.toLocaleString();
    $("metric-countries").textContent = summary.countries.toLocaleString();
    breakdown($("countries"), summary.topCountries, row => countryLabel(row.country));
    breakdown($("pages"), summary.pages, row => pageNames[row.path] || row.path);
    $("range-label").textContent = (summary.from === null ? "All dates" : `${summary.from} to ${summary.to}`) + " | Tokyo (UTC+09:00)";
    renderVisits(visits);
    $("export").disabled = $("delete").disabled = total === 0;
  } catch (error) {
    if (error.name !== "AbortError") {
      $("dashboard-error").textContent = error.message;
      emptyRow("Records unavailable");
    }
  }
}

function signOut() {
  controller?.abort(); accessKey = ""; total = 0; offset = 0;
  $("access-key").value = "";
  $("dashboard").hidden = $("logout").hidden = true;
  $("login-view").hidden = false;
  $("login-error").textContent = "";
  $("visits").replaceChildren(); $("countries").replaceChildren(); $("pages").replaceChildren();
  $("access-key").focus();
}

$("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  accessKey = $("access-key").value.trim();
  $("login-button").disabled = true;
  $("login-error").textContent = "";
  activeFilters = currentFilters();
  try {
    await api(`/api/summary?${params()}`);
    $("access-key").value = "";
    $("login-view").hidden = true;
    $("dashboard").hidden = $("logout").hidden = false;
    await load();
  } catch (error) { accessKey = ""; $("login-error").textContent = error.message; }
  finally { $("login-button").disabled = false; }
});
$("logout").addEventListener("click", signOut);
$("date-range").addEventListener("change", () => {
  const value = $("date-range").value;
  $("from").disabled = $("to").disabled = value === "all";
  if (value === "7" || value === "30") {
    $("from").value = date(Date.now() - (Number(value) - 1) * 86400000);
    $("to").value = date(Date.now());
  }
});
for (const id of ["from", "to"]) $(id).addEventListener("input", () => { $("date-range").value = "custom"; });
$("filters").addEventListener("submit", event => { event.preventDefault(); activeFilters = currentFilters(); offset = 0; load(); });
$("refresh").addEventListener("click", load);
$("reveal").addEventListener("change", () => { offset = 0; load(); });
$("previous").addEventListener("click", () => { offset = Math.max(0, offset - 50); load(); });
$("next").addEventListener("click", () => { offset += 50; load(); });
$("export").addEventListener("click", async () => {
  $("export").disabled = true;
  try {
    const response = await api(`/api/export?${params()}`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = url;
    link.download = activeFilters.get("allTime") === "1" ? "visits-all-dates.csv" : `visits-${activeFilters.get("from")}-${activeFilters.get("to")}.csv`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) { $("dashboard-error").textContent = error.message; }
  finally { $("export").disabled = total === 0; }
});
$("delete").addEventListener("click", async () => {
  if (!confirm(`Permanently delete ${total.toLocaleString()} visits matching these filters?`)) return;
  $("delete").disabled = true;
  try {
    await api(`/api/visits?${params()}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "delete-filtered" }) });
    offset = 0; await load();
  } catch (error) { $("dashboard-error").textContent = error.message; $("delete").disabled = false; }
});
