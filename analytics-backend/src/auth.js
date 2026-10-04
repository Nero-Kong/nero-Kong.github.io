import { createRemoteJWKSet, jwtVerify } from "jose";

const keySets = new Map();

export function authMode(env) {
  return env.AUTH_MODE || "bearer";
}

export function accessConfig(env) {
  const issuer = env.ACCESS_TEAM_DOMAIN;
  const audience = env.ACCESS_AUD;
  const email = env.ACCESS_ALLOWED_EMAIL;
  if (typeof issuer !== "string" || !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(issuer)
    || typeof audience !== "string" || !/^[a-zA-Z0-9_-]{16,256}$/.test(audience)
    || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return { issuer, audience, email: email.toLowerCase() };
}

export function authReady(env) {
  if (authMode(env) === "cloudflare-access") return Boolean(accessConfig(env));
  return authMode(env) === "bearer" && typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length >= 32;
}

export async function verifyAccessToken(token, config, keys) {
  if (!config || typeof token !== "string" || token.length > 16384) throw new Error("Access required.");
  if (!keys) {
    if (!keySets.has(config.issuer)) {
      keySets.set(config.issuer, createRemoteJWKSet(new URL(`${config.issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 }));
    }
    keys = keySets.get(config.issuer);
  }
  const { payload } = await jwtVerify(token, keys, {
    issuer: config.issuer, audience: config.audience, algorithms: ["RS256"],
    requiredClaims: ["sub", "email", "iat", "exp"]
  });
  if (typeof payload.sub !== "string" || !payload.sub || typeof payload.email !== "string"
    || payload.email.toLowerCase() !== config.email) throw new Error("Access denied.");
  return { mode: "cloudflare-access", email: payload.email };
}
