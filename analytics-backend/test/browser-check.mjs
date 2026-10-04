import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const origin = "http://127.0.0.1:8788";
const root = fileURLToPath(new URL("..", import.meta.url));
const token = (await readFile(new URL("../.dev.vars", import.meta.url), "utf8")).match(/^ADMIN_TOKEN=(\S+)$/m)[1];
const artifacts = new URL("../test-artifacts/", import.meta.url);
await mkdir(artifacts, { recursive: true });
await assert.rejects(readFile(new URL("../../privacy.html", import.meta.url)), { code: "ENOENT" });
for (const file of ["index.html", "project.html", "panosomafly.html", "crop-ar.html"]) {
  const html = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
  assert.ok(!html.includes('href="privacy.html"'), `${file} must not link to the removed privacy page`);
}
const testIds = Array.from({ length: 53 }, () => crypto.randomUUID());
const seed = testIds.map((id, i) => `INSERT INTO visits (event_id, visited_at, ip, country, region, city, network, asn, path) VALUES
  ('${id}', ${i === 52 ? Date.now() - 400 * 86400000 : Date.now() - i * 1000}, '203.0.113.${i + 1}', 'JP', 'Tokyo', 'Bunkyo', 'Example University Test Network', 64500, '/');`).join("\n");
const cli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
function sql(command) {
  const result = spawnSync(process.execPath, [cli, "d1", "execute", "DB", "--local", "--command", command], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
sql(seed);
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${origin}/admin`);
  await page.locator("#access-key").fill("b".repeat(43));
  await page.locator("#login-button").click();
  await page.waitForFunction(() => document.getElementById("login-error").textContent.includes("Invalid"));
  assert.equal(await page.locator("#dashboard").isVisible(), false);
  await page.locator("#access-key").fill(token);
  await page.locator("#login-button").click();
  await page.waitForFunction(() => document.getElementById("metric-visits").textContent === "52");
  await page.locator("#visits td.mono").nth(1).waitFor();
  assert.ok((await page.locator("#visits td.mono").nth(1).innerText()).endsWith(".*"));
  assert.equal(await page.locator("#visits tr").count(), 50);
  assert.ok(await page.locator("svg").count() >= 8);
  await page.screenshot({ path: fileURLToPath(new URL("dashboard-desktop.png", artifacts)), fullPage: true });
  await page.locator("#next").click();
  await page.waitForFunction(() => document.getElementById("page-status").textContent.startsWith("51-52"));
  await page.locator("#reveal").check();
  await page.waitForFunction(() => document.querySelector("#visits td:nth-child(2)")?.textContent === "203.0.113.1");
  const download = page.waitForEvent("download"); await page.locator("#export").click();
  assert.ok((await download).suggestedFilename().endsWith(".csv"));
  await page.locator("#date-range").selectOption("all");
  await page.locator("#filters button").click();
  await page.waitForFunction(() => document.getElementById("metric-visits").textContent === "53");
  assert.equal(await page.locator("#from").isDisabled(), true);
  assert.ok((await page.locator("#range-label").innerText()).startsWith("All dates"));
  await page.locator("#next").click();
  await page.waitForFunction(() => document.getElementById("page-status").textContent.startsWith("51-53"));
  assert.ok((await page.locator("#visits").innerText()).includes("203.0.113.53"));
  const allDownload = page.waitForEvent("download"); await page.locator("#export").click();
  assert.equal((await allDownload).suggestedFilename(), "visits-all-dates.csv");
  await page.locator("#date-range").selectOption("7");
  await page.locator("#filters button").click();
  await page.waitForFunction(() => document.getElementById("metric-visits").textContent === "52");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: fileURLToPath(new URL("dashboard-mobile.png", artifacts)), fullPage: true });
  for (const width of [320, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#search").fill("not-a-real-network");
  await page.locator("#filters button").click();
  await page.waitForFunction(() => document.getElementById("metric-visits").textContent === "0");
  assert.equal(await page.locator("#export").isDisabled(), true);
  await page.locator("#search").fill("Example University");
  await page.locator("#filters button").click();
  await page.waitForFunction(() => document.getElementById("metric-visits").textContent === "52");
  page.once("dialog", dialog => dialog.accept());
  await page.locator("#delete").click();
  await page.waitForFunction(() => document.getElementById("metric-visits").textContent === "0");
  await page.locator("#logout").click();
  assert.equal(await page.locator("#login-view").isVisible(), true);
  assert.equal(await page.locator("#visits tr").count(), 0);
  await page.screenshot({ path: fileURLToPath(new URL("login-mobile.png", artifacts)), fullPage: true });
  assert.deepEqual(errors, []);

  // A synthetic page verifies the tracker, without loading the real portfolio or third-party media.
  const tracker = await readFile(new URL("../../assets/visitor-analytics.js", import.meta.url), "utf8");
  const testUrl = "https://nero-kong.github.io/tracker-test";
  const scaffold = `<!doctype html><html><head></head><body><h1>Analytics test</h1>
    <script>window.PORTFOLIO_ANALYTICS={endpoint:'https://analytics.example'};</script><script>${tracker}</script></body></html>`;
  await context.route(testUrl + "*", route => route.fulfill({ contentType: "text/html", body: scaffold }));
  let sent = [];
  await context.route("https://analytics.example/collect", route => {
    sent.push(JSON.parse(route.request().postData()));
    return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "https://nero-kong.github.io" } });
  });
  await page.goto(testUrl + "?private=yes#secret");
  await page.waitForTimeout(150);
  assert.equal(sent.length, 1);
  assert.equal(await page.locator("aside, dialog").count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal("consent" in sent[0], false);
  assert.equal(sent[0].path, "/tracker-test");
  assert.ok(!JSON.stringify(sent).includes("private=yes"));
  await page.addScriptTag({ content: tracker }); assert.equal(sent.length, 1);
  await page.reload(); await page.waitForTimeout(150); assert.equal(sent.length, 2);
  await page.evaluate(() => {
    localStorage.setItem("portfolio-analytics-disabled-v1", "1");
    localStorage.setItem("portfolio-analytics-consent-v1", JSON.stringify({ value: "denied", time: Date.now() }));
  });
  await page.reload(); await page.waitForTimeout(150); assert.equal(sent.length, 3);
  await page.evaluate(() => {
    localStorage.removeItem("portfolio-analytics-disabled-v1");
  });
  await page.reload(); await page.waitForTimeout(150); assert.equal(sent.length, 4);
  for (const signals of [{ gpc: true, dnt: "0" }, { gpc: false, dnt: "1" }, { gpc: true, dnt: "1" }]) {
    const signalContext = await browser.newContext();
    await signalContext.addInitScript(({ gpc, dnt }) => {
      Object.defineProperty(navigator, "globalPrivacyControl", { value: gpc });
      Object.defineProperty(navigator, "doNotTrack", { value: dnt });
      try {
        localStorage.setItem("portfolio-analytics-disabled-v1", "1");
        localStorage.setItem("portfolio-analytics-consent-v1", JSON.stringify({ value: "denied" }));
      } catch (_) {}
    }, signals);
    await signalContext.route(testUrl, route => route.fulfill({ contentType: "text/html", body: scaffold }));
    await signalContext.route("https://analytics.example/collect", route => {
      sent.push(JSON.parse(route.request().postData()));
      return route.fulfill({ status: 204, headers: { "Access-Control-Allow-Origin": "https://nero-kong.github.io" } });
    });
    const signalPage = await signalContext.newPage();
    const before = sent.length;
    await signalPage.goto(testUrl);
    await signalPage.waitForTimeout(150);
    assert.equal(await signalPage.locator("aside, dialog, [data-analytics-preference]").count(), 0);
    assert.equal(sent.length, before + 1);
    await signalContext.close();
  }
  const disabledContext = await browser.newContext();
  await disabledContext.route(testUrl, route => route.fulfill({ contentType: "text/html", body: scaffold.replace("endpoint:'https://analytics.example'", "endpoint:''") }));
  const disabledPage = await disabledContext.newPage(); await disabledPage.goto(testUrl);
  assert.equal(await disabledPage.locator("aside, dialog").count(), 0);
  assert.equal(sent.length, 7);
  console.log("PASS: no public privacy page or visitor confirmation controls, desktop/mobile dashboard, historical/all-date queries, auth, pagination, full IPs, CSV, filters, deletion, logout, automatic logging independent of stored preferences and DNT/GPC, disabled configuration.");
} finally {
  await browser?.close();
  sql(`DELETE FROM visits WHERE event_id IN (${testIds.map(id => `'${id}'`).join(",")});`);
}
