import { readFile, writeFile } from "node:fs/promises";
import { accessConfig } from "../src/auth.js";

const [team, audience, email] = process.argv.slice(2);
const vars = { AUTH_MODE: "cloudflare-access", ACCESS_TEAM_DOMAIN: `https://${team}.cloudflareaccess.com`, ACCESS_AUD: audience };
if (!accessConfig({ ...vars, ACCESS_ALLOWED_EMAIL: email })) throw new Error("Usage: node scripts/configure-access.mjs <team-name> <application-audience> <owner-email>");

// Run only after the Access application's paths, owner policy and login method are saved.
const target = new URL("../wrangler.json", import.meta.url);
const config = JSON.parse(await readFile(target, "utf8"));
config.vars = { ...config.vars, ...vars };
const secretsFile = new URL("../.production.vars", import.meta.url);
const secrets = await readFile(secretsFile, "utf8");
await writeFile(secretsFile, secrets.replace(/^ACCESS_ALLOWED_EMAIL=.*\r?\n?/gm, "").trimEnd() + `\nACCESS_ALLOWED_EMAIL=${email}\n`, { mode: 0o600 });
await writeFile(target, JSON.stringify(config, null, 2) + "\n");
await import("./prepare-local.mjs");
console.log("Configured Cloudflare Access. Owner email is in ignored secrets; deploy to activate.");
