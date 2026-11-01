// The whole controls flow. Runs in WebKit too, because the owner may present from an iPad.
import {
  connected,
  draw,
  expect,
  goToSteppedSlide,
  inkIds,
  position,
  presenterContext,
  Proxy,
  test,
  tool,
} from "./harness.ts";

test("controls flow: connect, navigate, draw, text, undo, panel, reconnect", async ({ browser, server, deckSlug }) => {
  const proxy = new Proxy(server.port);
  await proxy.up();
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${proxy.url}/controls/${deckSlug}`);
  await connected(controls);
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await connected(viewer);
  await expect(controls.locator('[data-live-role="viewers"]')).toHaveText("1 viewer");

  await controls.keyboard.press("ArrowRight");
  await expect.poll(() => position(viewer)).toEqual(await position(controls));
  await goToSteppedSlide(controls, 1);
  await expect.poll(() => position(viewer)).toEqual(await position(controls));

  const before = await position(controls);
  await tool(controls, "Pen");
  await draw(controls, [200, 200], [500, 300]);
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  expect(await position(controls)).toEqual(before);

  await tool(controls, "Text");
  const box = await controls.locator(".reveal .slides").boundingBox();
  await controls.mouse.click(box!.x + 200, box!.y + 300);
  await expect(controls.locator(".live-text-editor")).toBeFocused();
  await controls.keyboard.type("ťažké");
  await controls.keyboard.press("Enter");
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);
  await expect(viewer.locator('#live-overlay g[data-kind="text"] text')).toContainText("ťažké");

  await tool(controls, "Undo");
  await expect.poll(() => inkIds(viewer)).toHaveLength(1);
  await tool(controls, "Redo");
  await expect.poll(() => inkIds(viewer)).toHaveLength(2);

  await expect(controls.frameLocator(".live-next-frame iframe").locator(".reveal")).toBeAttached();

  await viewer.locator(".live-ask").click();
  await viewer.locator(".live-sheet textarea").fill("Otázka z prehliadača");
  await viewer.locator(".live-sheet textarea").press("Enter");
  await expect(controls.locator(".live-panel .live-question")).toContainText("Otázka z prehliadača");
  await controls.keyboard.press("q");
  await expect(viewer.locator(".live-join")).toHaveClass(/live-join-full/);
  await expect.poll(() => viewer.locator(".live-join img").evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await controls.keyboard.press("w");
  await expect(viewer.locator(".live-screen-text")).toHaveText("Otázka z prehliadača");
  await controls.keyboard.press("w");
  await expect(viewer.locator(".live-join")).toBeHidden();
  await expect(viewer.locator(".live-question-screen")).toBeHidden();

  await tool(controls, "Pen");
  await proxy.down();
  await expect(controls.locator("html")).toHaveAttribute("data-live-state", "reconnecting");
  await draw(controls, [200, 450], [500, 450]);
  await expect.poll(() => inkIds(controls)).toHaveLength(3);
  await proxy.up();
  await connected(controls);
  await expect.poll(() => inkIds(viewer)).toHaveLength(3);
  await proxy.down();
});
