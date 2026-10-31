import { readFileSync } from "node:fs";
import type { Browser } from "@playwright/test";
import {
  connected,
  draw,
  expect,
  fixturePath,
  goToSteppedSlide,
  inkBox,
  inkIds,
  LiveServer,
  nextSlug,
  type Page,
  position,
  presenterContext,
  Proxy,
  test,
  tool,
} from "./harness.ts";

async function pair(browser: Browser, url: string, slug: string, viewport?: { width: number; height: number }) {
  const context = await presenterContext(browser);
  const controls = await context.newPage();
  await controls.goto(`${url}/controls/${slug}`);
  await connected(controls);
  const viewerContext = await browser.newContext(viewport ? { viewport } : {});
  const viewer = await viewerContext.newPage();
  await viewer.goto(`${url}/${slug}`);
  await connected(viewer);
  return { controls, viewer };
}

async function follow(controls: Page, viewer: Page) {
  const expected = await position(controls);
  await expect.poll(() => position(viewer)).toEqual(expected);
}

test("a stroke drawn at step N is hidden at N-1 and visible at N and N+1, on both pages", async ({ browser, server, deckSlug }) => {
  const { controls, viewer } = await pair(browser, server.url, deckSlug);
  const { h, v } = await goToSteppedSlide(controls, 1);
  await follow(controls, viewer);

  await tool(controls, "Pen");
  await draw(controls, [200, 200], [500, 300]);
  await expect.poll(() => inkIds(controls)).toHaveLength(1);
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  const [id] = await inkIds(controls);

  const atStep = async (f: number, visible: boolean) => {
    await controls.evaluate(([h, v, f]) => window.Reveal.slide(h!, v!, f), [h, v, f]);
    await follow(controls, viewer);
    for (const page of [controls, viewer]) {
      await expect.poll(() => inkIds(page)).toEqual(visible ? [id] : []);
    }
  };
  await atStep(0, false);
  await atStep(1, true);
  await atStep(2, true);

  // The keyboard still drives the deck with a tool active.
  await atStep(1, true);
  await controls.keyboard.press("ArrowLeft");
  await follow(controls, viewer);
  expect((await position(controls)).f).toBe(0);
  expect(await inkIds(viewer)).toEqual([]);
  await controls.keyboard.press("ArrowRight");
  await follow(controls, viewer);
  await expect.poll(() => inkIds(viewer)).toEqual([id]);

  // Another slide shows nothing.
  await controls.evaluate(([h]) => window.Reveal.slide(h! + 1, 0), [h]);
  await follow(controls, viewer);
  await expect.poll(() => inkIds(viewer)).toEqual([]);
});

test("clicks draw with a tool active and do not advance the deck; live strokes reach viewers mid-draw", async ({ browser, server, deckSlug }) => {
  const { controls, viewer } = await pair(browser, server.url, deckSlug);
  await goToSteppedSlide(controls, 0);
  await follow(controls, viewer);
  const before = await position(controls);

  await tool(controls, "Pen");
  await controls.mouse.move(300, 300);
  await controls.mouse.down();
  await controls.mouse.move(420, 340, { steps: 5 });
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  await controls.mouse.move(520, 340, { steps: 5 });
  await controls.mouse.up();
  await controls.mouse.click(600, 400);
  expect(await position(controls)).toEqual(before);
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);
});

test("undo, redo, eraser and clear slide stay in step on both pages", async ({ browser, server, deckSlug }) => {
  const { controls, viewer } = await pair(browser, server.url, deckSlug);
  await tool(controls, "Pen");
  await draw(controls, [100, 100], [300, 100]);
  await draw(controls, [100, 300], [300, 300]);
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);

  await tool(controls, "Undo");
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  await tool(controls, "Redo");
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);

  await tool(controls, "Eraser");
  await draw(controls, [200, 280], [200, 320]);
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  await controls.keyboard.press("Control+z");
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);

  controls.once("dialog", (dialog) => dialog.accept());
  await tool(controls, "Clear slide");
  await expect.poll(() => inkIds(viewer)).toEqual([]);
  expect(await inkIds(controls)).toEqual([]);
  await tool(controls, "Undo");
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);

  const late = await (await browser.newContext()).newPage();
  await late.goto(`${server.url}/${deckSlug}`);
  await connected(late);
  await expect.poll(() => inkIds(late)).toEqual(await inkIds(controls));
});

test("a late joiner gets the same slide, step and ink", async ({ browser, server, deckSlug }) => {
  const { controls, viewer } = await pair(browser, server.url, deckSlug);
  await goToSteppedSlide(controls, 1);
  await tool(controls, "Pen");
  await draw(controls, [200, 400], [500, 450]);
  await tool(controls, "Highlighter");
  await draw(controls, [200, 500], [500, 500]);
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);

  const late = await (await browser.newContext()).newPage();
  await late.goto(`${server.url}/${deckSlug}`);
  await connected(late);
  await expect.poll(() => position(late)).toEqual(await position(controls));
  await expect.poll(() => inkIds(late)).toEqual(await inkIds(controls));
  const [id] = await inkIds(controls);
  expect(await inkBox(late, id!)).toEqual(await inkBox(controls, id!));
});

test("ink lands on the same slide coordinates at two viewport sizes", async ({ browser, server, deckSlug }) => {
  const { controls, viewer } = await pair(browser, server.url, deckSlug, { width: 1920, height: 1080 });
  await tool(controls, "Pen");
  await draw(controls, [640, 200], [640, 500]);
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  const [id] = await inkIds(viewer);

  const box = await inkBox(controls, id!);
  expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(3);
  expect(Math.abs(box.y - 200)).toBeLessThan(6);
  expect(Math.abs(box.y + box.height - 500)).toBeLessThan(6);
  expect(await inkBox(viewer, id!)).toEqual(box);

  // On screen, the ink sits at the same fraction of the slide at any size.
  const fraction = (page: Page) =>
    page.evaluate((id) => {
      const ink = document.querySelector(`#live-overlay g[data-item-id="${id}"]`)!.getBoundingClientRect();
      const slide = document.querySelector(".reveal .slides")!.getBoundingClientRect();
      return { x: (ink.x - slide.x) / slide.width, y: (ink.y - slide.y) / slide.height };
    }, id);
  const large = await fraction(viewer);
  await viewer.setViewportSize({ width: 640, height: 900 });
  await viewer.waitForTimeout(100);
  const small = await fraction(viewer);
  expect(Math.abs(large.x - small.x)).toBeLessThan(0.003);
  expect(Math.abs(large.y - small.y)).toBeLessThan(0.003);
});

test("pointer mapping holds with a non-zero margin, at several window sizes", async ({ browser, server }) => {
  const html = readFileSync(fixturePath, "utf8");
  expect(html).toContain("margin: 0,");
  const deck = await server.upload(html.replace("margin: 0,", "margin: 0.15,"), "margin.html");
  const slug = nextSlug();
  await server.createSession(slug, deck.id);

  const { controls } = await pair(browser, server.url, slug);
  await tool(controls, "Pen");
  for (const [width, height] of [[1280, 800], [1000, 900], [1800, 700]] as const) {
    await controls.setViewportSize({ width, height });
    await controls.waitForTimeout(100);
    const before = await inkIds(controls);
    await draw(controls, [640, 300], [640, 420]);
    await expect.poll(async () => (await inkIds(controls)).length).toBe(before.length + 1);
    const [id] = (await inkIds(controls)).filter((x) => !before.includes(x));
    const box = await inkBox(controls, id!);
    expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(4);
    expect(Math.abs(box.y - 300)).toBeLessThan(8);
  }
});

test("a presenter disconnected mid-draw loses no strokes after reconnecting", async ({ browser, server, deckSlug }) => {
  const proxy = new Proxy(server.port);
  await proxy.up();
  const context = await presenterContext(browser);
  const controls = await context.newPage();
  await controls.goto(`${proxy.url}/controls/${deckSlug}`);
  await connected(controls);
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await connected(viewer);

  await tool(controls, "Pen");
  await draw(controls, [100, 100], [300, 100]);
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);

  // The network dies with the pen down.
  await controls.mouse.move(100, 300);
  await controls.mouse.down();
  await controls.mouse.move(300, 300, { steps: 5 });
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);
  await proxy.down();
  await expect(controls.locator("html")).toHaveAttribute("data-live-state", "reconnecting");
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  await controls.mouse.move(500, 320, { steps: 5 });
  await controls.mouse.up();

  // A second stroke and an undo during the drop.
  await draw(controls, [100, 400], [300, 400]);
  await draw(controls, [100, 500], [300, 500]);
  await controls.keyboard.press("Control+z");
  await expect.poll(() => inkIds(controls)).toHaveLength(3);
  const expected = await inkIds(controls);
  expect(await inkIds(viewer)).toHaveLength(1);

  await proxy.up();
  await connected(controls);
  await expect.poll(() => inkIds(viewer)).toEqual(expected);
  await expect.poll(() => inkIds(controls)).toEqual(expected);

  const late = await (await browser.newContext()).newPage();
  await late.goto(`${server.url}/${deckSlug}`);
  await connected(late);
  await expect.poll(() => inkIds(late)).toEqual(expected);
  await proxy.down();
});

test("moves made during a drop reach the viewers after reconnecting", async ({ browser, server, deckSlug }) => {
  const proxy = new Proxy(server.port);
  await proxy.up();
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${proxy.url}/controls/${deckSlug}`);
  await connected(controls);
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await connected(viewer);

  await proxy.down();
  await expect(controls.locator("html")).toHaveAttribute("data-live-state", "reconnecting");
  await controls.keyboard.press("ArrowRight");
  await controls.keyboard.press("ArrowRight");
  const moved = await position(controls);
  await proxy.up();
  await connected(controls);
  await expect.poll(() => position(viewer)).toEqual(moved);
  expect(await position(controls)).toEqual(moved);
  await proxy.down();
});

test("two presenter devices stay in step through the server", async ({ browser, server, deckSlug }) => {
  const one = await (await presenterContext(browser)).newPage();
  const two = await (await presenterContext(browser)).newPage();
  await one.goto(`${server.url}/controls/${deckSlug}`);
  await two.goto(`${server.url}/controls/${deckSlug}`);
  await connected(one);
  await connected(two);

  await one.keyboard.press("ArrowRight");
  await follow(one, two);
  await tool(two, "Pen");
  await draw(two, [100, 100], [400, 100]);
  await expect.poll(() => inkIds(one)).toHaveLength(1);
  await two.keyboard.press("ArrowRight");
  await follow(two, one);
});

test("sessions and ink survive a server restart", async ({ browser }) => {
  const server = new LiveServer();
  await server.start();
  const deck = await server.upload();
  await server.createSession("cv05-a", deck.id);

  const { controls, viewer } = await pair(browser, server.url, "cv05-a");
  await goToSteppedSlide(controls, 1);
  await follow(controls, viewer);
  await tool(controls, "Pen");
  await draw(controls, [200, 200], [400, 200]);
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  const [id] = await inkIds(viewer);
  const at = await position(controls);

  await server.stop();
  await expect(viewer.locator("html")).toHaveAttribute("data-live-state", "reconnecting");
  await server.start();
  await connected(viewer);
  await connected(controls);

  const fresh = await (await browser.newContext()).newPage();
  await fresh.goto(`${server.url}/cv05-a`);
  await connected(fresh);
  await expect.poll(() => position(fresh)).toEqual(at);
  await expect.poll(() => inkIds(fresh)).toEqual([id]);
  await expect.poll(() => inkIds(viewer)).toEqual([id]);
  await server.dispose();
});

test("a viewer sending presenter messages is disconnected, and no state changes", async ({ server, deckSlug }) => {
  const { WebSocket } = await import("ws");
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${deckSlug}`, { origin: server.url });
  const closed = new Promise<number>((resolve) => socket.on("close", (code) => resolve(code)));
  await new Promise((resolve) => socket.on("open", resolve));
  socket.send(JSON.stringify({ v: 1, t: "position", position: { h: 5, v: 0, f: 1 } }));
  expect(await closed).toBe(4403);

  const check = new WebSocket(`ws://127.0.0.1:${server.port}/ws/${deckSlug}`, { origin: server.url });
  const snapshot = await new Promise<{ position: unknown }>((resolve) =>
    check.on("message", (data) => resolve(JSON.parse(data.toString()))),
  );
  expect(snapshot.position).toEqual({ h: 0, v: 0, f: -1 });
  check.close();
});

test("a text box appears on both pages, follows the step rule and is never parsed as HTML", async ({ browser, server, deckSlug }) => {
  const { controls, viewer } = await pair(browser, server.url, deckSlug);
  const { h, v } = await goToSteppedSlide(controls, 1);
  await follow(controls, viewer);

  await tool(controls, "Text");
  const box = await controls.locator(".reveal .slides").boundingBox();
  await controls.mouse.click(box!.x + box!.width / 3, box!.y + box!.height / 3);
  const editor = controls.locator(".live-text-editor");
  await expect(editor).toBeFocused();
  const payload = '<img src=x onerror="window.pwned=1">';
  await editor.fill(`Príklad ${payload}`);
  await controls.keyboard.press("ArrowRight"); // Stays in the editor, doesn't advance the deck.
  await controls.keyboard.press("Shift+Enter");
  await controls.keyboard.type("druhý riadok");
  await controls.keyboard.press("Enter");
  await expect(editor).toHaveCount(0);

  for (const page of [controls, viewer]) {
    const text = page.locator('#live-overlay g[data-kind="text"] text');
    await expect(text).toContainText("Príklad <img src=x");
    await expect(text.locator("tspan")).toHaveCount(2);
    await expect(page.locator("#live-overlay img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  }
  expect((await position(controls)).f).toBe(1);

  await controls.evaluate(([h, v]) => window.Reveal.slide(h!, v!, 0), [h, v]);
  await follow(controls, viewer);
  await expect.poll(() => inkIds(viewer)).toEqual([]);

  await controls.evaluate(([h, v]) => window.Reveal.slide(h!, v!, 1), [h, v]);
  await tool(controls, "Text");
  await tool(controls, "Undo");
  await expect.poll(() => inkIds(viewer)).toEqual([]);
  await expect(controls.getByRole("button", { name: "Redo" })).toBeEnabled();
});

test("side panel: next-step preview, notes, viewer count, connection state", async ({ browser, server }) => {
  const html = readFileSync(fixturePath, "utf8").replace(
    "</section>",
    '<aside class="notes"><p>Pripomeň <strong>príklad</strong> z minula.</p></aside></section>',
  );
  const deck = await server.upload(html, "notes.html");
  const slug = nextSlug();
  await server.createSession(slug, deck.id);

  const { controls, viewer } = await pair(browser, server.url, slug);
  await expect(controls.locator('[data-live-role="connection"]')).toHaveText("Connected");
  await expect(controls.locator('[data-live-role="viewers"]')).toHaveText("1 viewer");
  await expect(controls.locator(".live-notes")).toContainText("Pripomeň príklad z minula.");
  await expect(controls.locator(".live-notes strong")).toHaveText("príklad");

  const preview = controls.frameLocator(".live-next-frame iframe");
  const previewPosition = () =>
    controls.frames()[1]!.evaluate(() => {
      const { h, v, f } = window.Reveal.getIndices();
      return { h, v, f: f ?? -1 };
    });
  await expect(preview.locator(".reveal")).toBeAttached();
  await expect.poll(previewPosition).toEqual({ h: 1, v: 0, f: -1 });

  const { h, v } = await goToSteppedSlide(controls, 0);
  await expect.poll(previewPosition).toEqual({ h, v, f: 1 });

  await controls.evaluate(() => window.Reveal.slide(999, 999));
  await expect.poll(() => position(viewer)).toEqual(await position(controls));
  await expect(controls.locator(".live-end-note")).toBeVisible();

  await viewer.close();
  await expect(controls.locator('[data-live-role="viewers"]')).toHaveText("0 viewers");
});

test("a phone in portrait stays in slide view, follows, and shows ink in the right place", async ({ browser, server, deckSlug }) => {
  const context = await presenterContext(browser);
  const controls = await context.newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await connected(controls);
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })).newPage();
  await phone.goto(`${server.url}/${deckSlug}`);
  await connected(phone);
  expect(await phone.evaluate(() => (window.Reveal as unknown as { isScrollView(): boolean }).isScrollView())).toBe(false);

  await goToSteppedSlide(controls, 1);
  await follow(controls, phone);
  await tool(controls, "Pen");
  await draw(controls, [640, 200], [640, 500]);
  await expect.poll(() => inkIds(phone)).toHaveLength(1);
  const [id] = await inkIds(phone);
  const placed = await phone.evaluate((id) => {
    const ink = document.querySelector(`#live-overlay g[data-item-id="${id}"]`)!.getBoundingClientRect();
    const slide = document.querySelector(".reveal .slides")!.getBoundingClientRect();
    return { centre: (ink.x + ink.width / 2 - slide.x) / slide.width, fits: slide.right <= innerWidth + 1 };
  }, id);
  expect(Math.abs(placed.centre - 0.5)).toBeLessThan(0.01);
  expect(placed.fits).toBe(true);
});

test("pen pressure is stored, and touch is ignored once a pen has been seen, except for placing text", async ({ browser, server, deckSlug }) => {
  const { controls, viewer } = await pair(browser, server.url, deckSlug);
  await tool(controls, "Pen");

  const gesture = (pointerType: string, y: number) =>
    controls.evaluate(
      ([pointerType, y]) => {
        const svg = document.querySelector("#live-overlay")!;
        const box = svg.getBoundingClientRect();
        const fire = (type: string, x: number, pressure: number) =>
          svg.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              pointerType: pointerType as string,
              pressure,
              clientX: box.left + x,
              clientY: box.top + (y as number),
            }),
          );
        const capture = svg.setPointerCapture;
        svg.setPointerCapture = () => {}; // Synthetic pointers have no capture target.
        fire("pointerdown", 100, 0.2);
        fire("pointermove", 200, 0.6);
        fire("pointermove", 300, 0.9);
        fire("pointerup", 300, 0);
        svg.setPointerCapture = capture;
      },
      [pointerType, y],
    );

  await gesture("touch", 100); // No pen so far, so a finger draws.
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  await gesture("pen", 200);
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);
  await gesture("touch", 300); // A palm now.
  await controls.waitForTimeout(200);
  expect(await inkIds(viewer)).toHaveLength(2);

  await expect
    .poll(async () => {
      const html = await (await server.request("GET", `/controls/${deckSlug}/export`)).text();
      const data = JSON.parse(/id="live-data">(.*?)<\/script>/.exec(html)![1]!) as {
        items: { data: { pen?: boolean; points: number[][] } }[];
      };
      return data.items.find((item) => item.data.pen)?.data.points.map((p) => p[2]);
    })
    .toEqual([0.2, 0.6, 0.9]);

  await tool(controls, "Text");
  await gesture("touch", 400);
  await expect(controls.locator(".live-text-editor")).toBeFocused();
});
