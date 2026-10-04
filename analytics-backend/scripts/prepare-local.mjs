import { randomBytes } from "node:crypto";
import { writeFile, readFile } from "node:fs/promises";

const target = new URL("../.dev.vars", import.meta.url);
try {
  const existing = await readFile(target, "utf8");
  if (!/^AUTH_MODE=/m.test(existing)) await writeFile(target, existing.trimEnd() + "\nAUTH_MODE=bearer\n", { mode: 0o600 });
  console.log("Local credentials already exist; local authentication stays in bearer mode.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await writeFile(target, `ADMIN_TOKEN=${randomBytes(32).toString("base64url")}\nAUTH_MODE=bearer\n`, { flag: "wx", mode: 0o600 });
  console.log("Created ignored .dev.vars with a random local access key. Do not commit it.");
}
