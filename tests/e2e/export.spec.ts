import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connected,
  draw,
  expect,
  goToSteppedSlide,
  inkBox,
  inkIds,
  position,
  presenterContext,
  test,
  tool,
} from "./harness.ts";

test("the export renders the same ink from file:// with networking blocked", async ({ browser, server, deckSlug }) => {
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await connected(controls);

  const { h, v } = await goToSteppedSlide(controls, 1);
  await tool(controls, "Pen");
  await draw(controls, [200, 200], [500, 300]);
  await tool(controls, "Text");
  const box = await controls.locator(".reveal .slides").boundingBox();
  await controls.mouse.click(box!.x + 200, box!.y + 300);
  await controls.keyboard.type("</script><b>žltá</b>");
  await controls.keyboard.press("Enter");
  await expect.poll(() => inkIds(controls)).toHaveLength(2);
  const expected = await inkIds(controls);
  const boxes = await Promise.all(expected.map((id) => inkBox(controls, id)));
  await expect
    .poll(async () => JSON.parse(await (await server.request("GET", "/api/state")).text()).sessions.find((s: { slug: string }) => s.slug === deckSlug).items)
    .toBe(2);

  const response = await server.request("GET", `/controls/${deckSlug}/export`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toMatch(
    new RegExp(`attachment; filename="${deckSlug}-\\d{4}-\\d{2}-\\d{2}-annotated\\.html"`),
  );
  const html = await response.text();
  expect(html).not.toContain("live-client.js");
  expect(html).not.toContain("WebSocket(");
  expect(html.split('id="live-data"')).toHaveLength(2);

  const repeat = await server.request("GET", `/controls/${deckSlug}/export`);
  expect((await repeat.text()).length).toBe(html.length);

  const dir = mkdtempSync(join(tmpdir(), "live-export-"));
  const file = join(dir, "annotated.html");
  writeFileSync(file, html);

  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  const remote: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("file:") && !url.startsWith("data:") && !url.startsWith("blob:")) remote.push(url);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await context.routeWebSocket(/.*/, () => {
    remote.push("websocket");
  });
  await page.goto(`file://${file}`);
  await page.waitForFunction(() => window.Reveal?.isReady());
  await page.waitForSelector("#live-overlay", { state: "attached" });

  // Free navigation, same step rule.
  await page.evaluate(([h, v]) => window.Reveal.slide(h!, v!, 0), [h, v]);
  await expect.poll(() => inkIds(page)).toEqual([]);
  await page.evaluate(([h, v]) => window.Reveal.slide(h!, v!, 1), [h, v]);
  await expect.poll(() => inkIds(page)).toEqual(expected);
  await page.evaluate(([h, v]) => window.Reveal.slide(h!, v!, 2), [h, v]);
  await expect.poll(() => inkIds(page)).toEqual(expected);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await position(page)).f).toBe(1);
  await expect.poll(() => inkIds(page)).toEqual(expected);
  await page.evaluate(([h]) => window.Reveal.slide(h! + 1, 0), [h]);
  await expect.poll(() => inkIds(page)).toEqual([]);
  await page.evaluate(([h, v]) => window.Reveal.slide(h!, v!, 1), [h, v]);
  await expect.poll(() => inkIds(page)).toEqual(expected);

  const exported = await Promise.all(expected.map((id) => inkBox(page, id)));
  expect(exported).toEqual(boxes);
  await expect(page.locator('#live-overlay g[data-kind="text"] text')).toContainText("</script><b>žltá</b>");

  expect(remote).toEqual([]);
  expect(errors).toEqual([]);
  await context.close();
  rmSync(dir, { recursive: true, force: true });
});

test("the export starts from the original upload, and an empty session still exports", async ({ server, deckSlug }) => {
  const html = await (await server.request("GET", `/controls/${deckSlug}/export`)).text();
  expect(html).toContain('{"items":[]}');
  expect(html.match(/live-client\.js/g)).toBeNull();
});
