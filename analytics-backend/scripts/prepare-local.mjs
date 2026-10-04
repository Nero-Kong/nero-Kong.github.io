import { randomBytes } from "node:crypto";
import { writeFile, access } from "node:fs/promises";

const target = new URL("../.dev.vars", import.meta.url);
try { await access(target); console.log("Local credentials already exist."); }
catch (_) {
  await writeFile(target, `ADMIN_TOKEN=${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
  console.log("Created ignored .dev.vars with a random local access key. Do not commit it.");
}
