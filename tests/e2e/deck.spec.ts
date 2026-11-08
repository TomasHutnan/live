import { readFileSync } from "node:fs";
import { expect, fixturePath, nextSlug, presenterContext, test } from "./harness.ts";

test("uploads, rejects non-decks, dedupes and warns", async ({ server }) => {
  const html = readFileSync(fixturePath, "utf8");

  const form = new FormData();
  form.append("file", new Blob(["<html><body>nope</body></html>"]), "x.html");
  const bad = await server.request("POST", "/api/decks", form);
  expect(bad.status).toBe(422);
  expect(await bad.text()).toContain("Reveal.initialize");

  const changed = `${html}<!-- changed -->`;
  const first = await server.upload(changed, "a.html");
  const second = await server.upload(changed, "a.html");
  expect(second.id).toBe(first.id);
  const third = await server.upload(`${changed}<!-- again -->`, "a.html");
  expect(third.id).not.toBe(first.id);

  const warnForm = new FormData();
  warnForm.append(
    "file",
    new Blob([`<html><body><img src="figures/a.png"><script>Reveal.initialize({})</script></body></html>`]),
    "w.html",
  );
  const warned = await server.request("POST", "/api/decks", warnForm);
  expect(warned.status).toBe(201);
  expect(((await warned.json()) as { warnings: string[] }).warnings.join()).toContain("figures/a.png");
});

test("rejects an upload over 50 MB", async ({ server }) => {
  const form = new FormData();
  form.append("file", new Blob([Buffer.alloc(51 * 1024 * 1024, 32)]), "big.html");
  const response = await server.request("POST", "/api/decks", form);
  expect(response.status).toBe(413);
  expect(await response.text()).toContain("50 MB");
});

test("serves the deck with the client injected and a working ETag", async ({ server, deckSlug }) => {
  const response = await fetch(`${server.url}/${deckSlug}`);
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body.match(/live-client\.js/g)).toHaveLength(1);
  expect(body.lastIndexOf("live-client.js")).toBeGreaterThan(body.indexOf("Reveal.initialize"));
  const etag = response.headers.get("etag")!;
  expect(etag).toBeTruthy();
  const again = await fetch(`${server.url}/${deckSlug}`, { headers: { "If-None-Match": etag } });
  expect(again.status).toBe(304);
});

test("protects the owner's routes and keeps the viewer public", async ({ server, deckSlug }) => {
  for (const path of ["/dashboard", `/controls/${deckSlug}`, `/controls/${deckSlug}/next`, `/controls/${deckSlug}/export`, "/api/state"]) {
    const denied = await fetch(server.url + path);
    expect(denied.status, path).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");
  }
  expect((await fetch(`${server.url}/api/decks`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${server.url}/controls/${deckSlug}/token`, { method: "POST" })).status).toBe(401);
  expect((await fetch(`${server.url}/${deckSlug}`)).status).toBe(200);
  expect((await server.request("GET", `/controls/${deckSlug}`)).status).toBe(200);
});

test("serves a public homepage whose code box leads to the viewer", async ({ server, deckSlug, browser }) => {
  const root = await fetch(server.url, { headers: { "Accept-Language": "sk,en;q=0.8" } });
  expect(root.status).toBe(200);
  const body = await root.text();
  expect(body).toContain('lang="sk"');
  expect(body).toContain("Kód seminára");
  expect(body).not.toContain("How it works");

  const page = await (await browser.newContext({ locale: "en-GB" })).newPage();
  await page.goto(server.url);
  const code = page.getByLabel("Session code");
  await code.fill(` ${deckSlug.toUpperCase()} `);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page).toHaveURL(`${server.url}/${deckSlug}`);

  await page.goto(server.url);
  await page.getByLabel("Session code").fill("<b>nope</b>");
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page.getByRole("alert")).toHaveText("There is no session called “<b>nope</b>”. Check the code on the board.");
  await expect(page.getByLabel("Session code")).toHaveValue("<b>nope</b>");
  // Reserved words are not sessions, even though their routes exist.
  expect((await fetch(`${server.url}/?code=dashboard`, { redirect: "manual" })).status).toBe(404);
});

test("links the homepage to the write-up when one is configured", async ({ ownServer }) => {
  const server = await ownServer({ LIVE_ABOUT_URL: "https://example.com/live" });
  const body = await (await fetch(server.url)).text();
  expect(body).toContain('href="https://example.com/live"');
});

test("returns a plain 404 for unknown slugs", async ({ server }) => {
  const missing = await fetch(`${server.url}/no-such-session`);
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("Not found");
});

test("refuses a cross-site non-GET request even with credentials", async ({ server, deckSlug }) => {
  const response = await server.request("DELETE", `/api/sessions/${deckSlug}`, JSON.stringify({ confirm: deckSlug }), {
    "Content-Type": "application/json",
    Origin: "https://evil.example",
  });
  expect(response.status).toBe(403);
  expect((await fetch(`${server.url}/${deckSlug}`)).status).toBe(200);
});

test("validates slugs and protects decks in use", async ({ server, deckId, deckSlug }) => {
  const post = (slug: string) =>
    server.request("POST", "/api/sessions", JSON.stringify({ slug, deckId }), { "Content-Type": "application/json" });
  expect((await post("controls")).status).toBe(400);
  expect((await post("Zlé")).status).toBe(400);
  expect((await post(deckSlug)).status).toBe(409);
  expect((await server.request("DELETE", `/api/decks/${deckId}`)).status).toBe(409);
});

test("dashboard: upload, suggest a slug, create, remove with typed confirmation, delete deck", async ({ server, browser }) => {
  const context = await presenterContext(browser);
  const page = await context.newPage();
  await page.goto(`${server.url}/dashboard`);
  await expect(page.getByRole("heading", { name: "live" })).toBeVisible();

  const name = `cv${nextSlug()}.html`;
  await page.locator('input[type="file"]').setInputFiles({
    name,
    mimeType: "text/html",
    buffer: Buffer.from(`${readFileSync(fixturePath, "utf8")}<!-- ${name} -->`),
  });
  const stem = name.replace(".html", "");
  await expect(page.locator('input[name="slug"]')).toHaveValue(`${stem}-a`);
  await page.getByRole("button", { name: "Create session" }).click();

  const card = page.locator(`article[data-slug="${stem}-a"]`);
  await expect(card).toBeVisible();
  await expect(page.locator('input[name="slug"]')).toHaveValue(`${stem}-b`);
  await expect(card.locator(".qr img")).toHaveJSProperty("complete", true);

  await card.getByRole("button", { name: "Remove" }).click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog.getByRole("link", { name: /Download the annotated deck/ })).toHaveAttribute(
    "href",
    `/controls/${stem}-a/export`,
  );
  const remove = dialog.getByRole("button", { name: "Remove session" });
  await expect(remove).toBeDisabled();
  await dialog.locator("input").fill("wrong");
  await expect(remove).toBeDisabled();
  await dialog.locator("input").fill(`${stem}-a`);
  await remove.click();
  await expect(card).toHaveCount(0);
  expect((await fetch(`${server.url}/${stem}-a`)).status).toBe(404);

  const deck = page.locator("article.card.row", { hasText: name });
  await deck.getByRole("button", { name: "Delete" }).click();
  await expect(deck).toHaveCount(0);
  await context.close();
});
