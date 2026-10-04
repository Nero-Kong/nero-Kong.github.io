import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const configFile = new URL("../wrangler.json", import.meta.url);

function run(args, capture = false) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root, encoding: "utf8", stdio: ["inherit", "pipe", "inherit"]
  });
  if (!capture && result.stdout) process.stdout.write(result.stdout);
  if (result.error || result.status !== 0) throw new Error(`Wrangler failed: ${args[0]}. Resolve the error above and retry.`);
  return result.stdout || "";
}

try {
  const identity = run(["whoami"], true);
  if (/not authenticated/i.test(identity)) throw new Error("Register at https://dash.cloudflare.com/sign-up, then run: node node_modules/wrangler/bin/wrangler.js login");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  let databases = JSON.parse(run(["d1", "list", "--json"], true));
  let database = databases.find(item => item.name === config.d1_databases[0].database_name);
  if (!database) {
    run(["d1", "create", config.d1_databases[0].database_name]);
    databases = JSON.parse(run(["d1", "list", "--json"], true));
    database = databases.find(item => item.name === config.d1_databases[0].database_name);
  }
  if (!database?.uuid) throw new Error("Cannot identify the analytics database. No website configuration was changed.");
  config.d1_databases[0].database_id = database.uuid;
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n");
  run(["d1", "migrations", "apply", "DB", "--remote"]);
  await import("./build-icons.mjs");

  const secretFile = new URL("../.production.vars", import.meta.url);
  let accessKey;
  try {
    const secrets = await readFile(secretFile, "utf8");
    accessKey = secrets.match(/^ADMIN_TOKEN=([A-Za-z0-9_-]{32,256})$/m)?.[1];
    if (!accessKey) throw new Error("The existing .production.vars has an invalid access key. Fix it before deploying.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    accessKey = randomBytes(32).toString("base64url");
    await writeFile(secretFile, `ADMIN_TOKEN=${accessKey}\n`, { flag: "wx", mode: 0o600 });
  }
  const output = run(["deploy", "--secrets-file", fileURLToPath(secretFile)]);
  const endpoint = output.match(/https:\/\/lingrong-visitor-analytics\.[a-z0-9-]+\.workers\.dev\b/i)?.[0];
  if (!endpoint) throw new Error("Deployment URL was not found. Frontend collection remains unchanged.");
  let healthy = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(10000) });
      healthy = response.ok && (await response.json()).ready === true;
    } catch (_) {}
    if (healthy) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!healthy) throw new Error("The deployed backend is not healthy. Frontend collection remains unchanged.");
  await writeFile(new URL("../.admin-access.json", import.meta.url),
    JSON.stringify({ adminUrl: `${endpoint}/admin`, accessKey }, null, 2) + "\n", { mode: 0o600 });
  await writeFile(new URL("../../assets/analytics-config.js", import.meta.url),
    "window.PORTFOLIO_ANALYTICS = Object.freeze(" + JSON.stringify({ endpoint }, null, 2) + ");\n");
  console.log(`Backend ready. Admin: ${endpoint}/admin`);
  console.log("Access key saved in ignored .admin-access.json; never put it in GitHub or website code.");
  console.log("Publish the website changes to GitHub Pages to enable automatic visit analytics. This script does not commit or push.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
