import { connected as ready, expect, position, presenterContext, test } from "./harness.ts";

test("viewer follows slides and steps, late joiner matches, viewer keys do nothing", async ({ browser, server, deckSlug }) => {
  const presenterCtx = await presenterContext(browser);
  const controls = await presenterCtx.newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await ready(controls);

  const viewerCtx = await browser.newContext();
  const viewer = await viewerCtx.newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await ready(viewer);

  // Walk far enough to cross fragments and vertical slides.
  for (let i = 0; i < 25; i++) {
    await controls.keyboard.press("ArrowRight");
    const expected = await position(controls);
    await expect.poll(() => position(viewer)).toEqual(expected);
  }
  for (let i = 0; i < 5; i++) {
    await controls.keyboard.press("ArrowLeft");
    const expected = await position(controls);
    await expect.poll(() => position(viewer)).toEqual(expected);
  }

  const held = await position(viewer);
  await viewer.keyboard.press("ArrowRight");
  await viewer.keyboard.press("Space");
  await viewer.waitForTimeout(100);
  expect(await position(viewer)).toEqual(held);

  const late = await (await browser.newContext()).newPage();
  await late.goto(`${server.url}/${deckSlug}`);
  await ready(late);
  await expect.poll(() => position(late)).toEqual(held);

  await presenterCtx.close();
  await viewerCtx.close();
});

test("browsing freely, then back to live", async ({ browser, server, deckSlug }) => {
  const presenterCtx = await presenterContext(browser);
  const controls = await presenterCtx.newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await ready(controls);
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await ready(viewer);

  await viewer.locator(".live-pill button").click();
  await viewer.keyboard.press("ArrowRight");
  await viewer.keyboard.press("ArrowRight");
  await expect.poll(async () => (await position(viewer)).h).toBeGreaterThan(0);

  for (let i = 0; i < 4; i++) await controls.keyboard.press("ArrowRight");
  const live = await position(controls);
  await viewer.waitForTimeout(200);
  expect(await position(viewer)).not.toEqual(live);

  await viewer.locator(".live-pill button").click();
  await expect.poll(() => position(viewer)).toEqual(live);
  await presenterCtx.close();
});

test("a viewer shows a disconnected state and recovers with the current position", async ({ browser }) => {
  // Own server: this test stops it.
  const { LiveServer } = await import("./harness.ts");
  const server = new LiveServer();
  await server.start();
  const deck = await server.upload();
  await server.createSession("cv05-a", deck.id);

  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/cv05-a`);
  await ready(viewer);
  await expect(viewer.locator(".live-banner")).toBeHidden();

  await server.stop();
  await expect(viewer.locator(".live-banner")).toBeVisible();
  await server.start();
  await ready(viewer);
  await expect(viewer.locator(".live-banner")).toBeHidden();
  await viewer.close();
  await server.dispose();
});

test("removing a session tells viewers, and the slug then returns 404", async ({ browser, server, deckSlug }) => {
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await ready(viewer);
  await server.removeSession(deckSlug);
  await expect(viewer.locator(".live-over")).toBeVisible();
  await expect(viewer.locator(".live-over")).toContainText("Prezentácia sa skončila");
  expect((await fetch(`${server.url}/${deckSlug}`)).status).toBe(404);
});

test("the upgrade checks Origin", async ({ server, deckSlug }) => {
  const { WebSocket } = await import("ws");
  const attempt = (origin?: string) =>
    new Promise<string>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${deckSlug}`, { origin });
      socket.on("open", () => {
        resolve("open");
        socket.close();
      });
      socket.on("unexpected-response", (_req, res) => resolve(String(res.statusCode)));
      socket.on("error", () => resolve("error"));
    });
  expect(await attempt(server.url)).toBe("open");
  expect(await attempt("https://evil.example")).toBe("403");
  expect(await attempt(undefined)).toBe("403");
});
