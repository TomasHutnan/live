import { hash } from "@node-rs/argon2";
import { beforeAll, describe, expect, it } from "vitest";
import { BasicAuth } from "../../src/server/auth.ts";
import { allowsUnsafeRequest, originMatches } from "../../src/server/origin.ts";

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("BasicAuth", () => {
  let passwordHash: string;
  beforeAll(async () => {
    passwordHash = await hash("heslo:s-dvojbodkou-š", { algorithm: 2 });
  });

  it("accepts the right credentials, including a colon and non-ASCII in the password", async () => {
    const auth = new BasicAuth("tomas", passwordHash);
    expect(await auth.check(basic("tomas", "heslo:s-dvojbodkou-š"), "1.1.1.1")).toBe(true);
  });

  it("rejects a wrong user, a wrong password, a missing header and garbage", async () => {
    const auth = new BasicAuth("tomas", passwordHash);
    expect(await auth.check(basic("root", "heslo:s-dvojbodkou-š"), "ip")).toBe(false);
    expect(await auth.check(basic("tomas", "nie"), "ip")).toBe(false);
    expect(await auth.check(undefined, "ip")).toBe(false);
    expect(await auth.check("Bearer abc", "ip")).toBe(false);
  });

  it("caches a success for a short time only", async () => {
    let now = 1_000;
    const auth = new BasicAuth("tomas", passwordHash, () => now);
    const header = basic("tomas", "heslo:s-dvojbodkou-š");
    await auth.check(header, "ip");
    const cached = performance.now();
    await auth.check(header, "ip");
    expect(performance.now() - cached).toBeLessThan(5);
    now += 61_000;
    expect(await auth.check(header, "ip")).toBe(true);
  });

  it("locks out an IP after repeated failures, and only that IP", async () => {
    let now = 1_000;
    const auth = new BasicAuth("tomas", passwordHash, () => now);
    for (let i = 0; i < 10; i++) await auth.check(basic("tomas", "x"), "bad");
    expect(auth.blockedFor("bad")).toBeGreaterThan(0);
    expect(auth.blockedFor("good")).toBe(0);
    now += 5 * 60_000 + 1;
    expect(auth.blockedFor("bad")).toBe(0);
  });
});

describe("Origin checks", () => {
  const pinned = { publicOrigin: "https://live.hutnan.dev" };
  const open = { publicOrigin: "" };

  it("compares against the configured origin exactly", () => {
    expect(originMatches("https://live.hutnan.dev", "ignored", pinned)).toBe(true);
    expect(originMatches("http://live.hutnan.dev", "live.hutnan.dev", pinned)).toBe(false);
    expect(originMatches("https://evil.example", "live.hutnan.dev", pinned)).toBe(false);
  });

  it("falls back to the request host", () => {
    expect(originMatches("http://localhost:8090", "localhost:8090", open)).toBe(true);
    expect(originMatches("https://evil.example", "localhost:8090", open)).toBe(false);
    expect(originMatches("null", "localhost:8090", open)).toBe(false);
  });

  it("lets a request with no Origin through, for curl", () => {
    expect(allowsUnsafeRequest(undefined, "h", pinned)).toBe(true);
    expect(allowsUnsafeRequest("https://evil.example", "h", pinned)).toBe(false);
    expect(allowsUnsafeRequest("https://live.hutnan.dev", "h", pinned)).toBe(true);
  });
});
