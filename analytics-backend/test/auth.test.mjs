import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet } from "jose";
import { authMode, authReady, accessConfig, verifyAccessToken } from "../src/auth.js";

const env = { AUTH_MODE: "cloudflare-access", ACCESS_TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  ACCESS_AUD: "test-audience-123456789", ACCESS_ALLOWED_EMAIL: "owner@example.com" };
const config = accessConfig(env);
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = await exportJWK(publicKey);
const keys = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });

function token(claims = {}, key = privateKey, alg = "RS256") {
  return new SignJWT({ email: "owner@example.com", ...claims }).setProtectedHeader({ alg, kid: "test-key" })
    .setSubject("test-owner").setIssuer(config.issuer).setAudience(config.audience)
    .setIssuedAt().setExpirationTime("24h").sign(key);
}

test("configuration accepts only a precise Cloudflare issuer, audience and owner", () => {
  assert.equal(authMode({}), "bearer");
  assert.equal(authReady(env), true);
  assert.equal(authReady({ AUTH_MODE: "unknown", ADMIN_TOKEN: "a".repeat(43) }), false);
  for (const issuer of ["http://test-team.cloudflareaccess.com", "https://evil.example", env.ACCESS_TEAM_DOMAIN + "/", env.ACCESS_TEAM_DOMAIN + "?query=1"]) {
    assert.equal(authReady({ ...env, ACCESS_TEAM_DOMAIN: issuer, ADMIN_TOKEN: "a".repeat(43) }), false);
  }
  for (const field of ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "ACCESS_ALLOWED_EMAIL"]) {
    assert.equal(authReady({ ...env, [field]: "" }), false);
  }
});

test("a verified owner JWT is accepted, with case-insensitive email matching", async () => {
  assert.deepEqual(await verifyAccessToken(await token(), config, keys), { mode: "cloudflare-access", email: "owner@example.com" });
  assert.equal((await verifyAccessToken(await token({ email: "OWNER@example.com" }), config, keys)).email, "OWNER@example.com");
});

test("other users, service identities, invalid signatures and malformed tokens are rejected", async () => {
  for (const email of ["other@example.com", "", null]) await assert.rejects(verifyAccessToken(await token({ email }), config, keys));
  const different = await generateKeyPair("RS256");
  await assert.rejects(verifyAccessToken(await token({}, different.privateKey), config, keys));
  for (const malformed of [null, "not-a-jwt", "x".repeat(16385)]) await assert.rejects(verifyAccessToken(malformed, config, keys));
});

test("issuer, audience, expiration, required claims and algorithm are enforced", async () => {
  for (const claims of [
    { iss: "https://other.cloudflareaccess.com", aud: config.audience, exp: Math.floor(Date.now() / 1000) + 3600 },
    { iss: config.issuer, aud: "another-app", exp: Math.floor(Date.now() / 1000) + 3600 },
    { iss: config.issuer, aud: config.audience, exp: 1 },
    { iss: config.issuer, aud: config.audience }
  ]) {
    const jwt = await new SignJWT({ sub: "owner", email: config.email, iat: Math.floor(Date.now() / 1000), ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(privateKey);
    await assert.rejects(verifyAccessToken(jwt, config, keys));
  }
  const jwt = await new SignJWT({ email: config.email }).setProtectedHeader({ alg: "HS256" }).setSubject("owner")
    .setIssuer(config.issuer).setAudience(config.audience).setIssuedAt().setExpirationTime("1h").sign(new Uint8Array(32));
  await assert.rejects(verifyAccessToken(jwt, config, keys));
});
