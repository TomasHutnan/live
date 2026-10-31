import { basicHeader, expect, test } from "./harness.ts";

test("failed logins are rate-limited per client IP, read through the trusted proxy", async ({ ownServer }) => {
  const server = await ownServer();
  const attempt = (ip: string, auth = "Basic eDp5") =>
    fetch(`${server.url}/dashboard`, { headers: { Authorization: auth, "X-Forwarded-For": ip } });

  for (let i = 0; i < 10; i++) expect((await attempt("203.0.113.1")).status).toBe(401);
  const blocked = await attempt("203.0.113.1");
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await attempt("203.0.113.2")).status).toBe(401);
});

test("X-Forwarded-For from a peer outside the trust list is ignored", async ({ ownServer }) => {
  const server = await ownServer({ LIVE_TRUST_PROXY: "10.9.9.9" });
  const attempt = (ip: string) =>
    fetch(`${server.url}/dashboard`, { headers: { Authorization: "Basic eDp5", "X-Forwarded-For": ip } });
  for (let i = 0; i < 10; i++) expect((await attempt(`203.0.113.${i}`)).status).toBe(401);
  // Every attempt counted against the real peer, whatever the header claimed.
  expect((await attempt("203.0.113.200")).status).toBe(429);
  expect((await fetch(`${server.url}/dashboard`, { headers: { Authorization: basicHeader } })).status).toBe(429);
});

test("tokens need credentials and a same-site Origin", async ({ server, deckSlug }) => {
  const ok = await server.request("POST", `/controls/${deckSlug}/token`, undefined, { Origin: server.url });
  expect(ok.status).toBe(200);
  const foreign = await server.request("POST", `/controls/${deckSlug}/token`, undefined, { Origin: "https://evil.example" });
  expect(foreign.status).toBe(403);
});
