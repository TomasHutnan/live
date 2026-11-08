import { readFileSync } from "node:fs";
import { connected, expect, nextSlug, type Page, position, presenterContext, Proxy, test, tool } from "./harness.ts";

const ask = async (page: Page, text: string) => {
  if (await page.locator(".live-sheet").isHidden()) await page.locator(".live-ask").click();
  await page.locator(".live-sheet textarea").fill(text);
  await page.locator(".live-sheet textarea").press("Enter");
};

test("a question reaches the presenter and other viewers, votes reorder it, and it can be closed", async ({ browser, server, deckSlug }) => {
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await connected(controls);
  const asker = await (await browser.newContext()).newPage();
  await asker.goto(`${server.url}/${deckSlug}`);
  await connected(asker);
  const neighbour = await (await browser.newContext()).newPage();
  await neighbour.goto(`${server.url}/${deckSlug}`);
  await connected(neighbour);

  await ask(asker, "Prvá otázka");
  await ask(asker, "<b>Druhá</b> otázka");
  const rows = controls.locator(".live-panel .live-question");
  await expect(rows).toHaveCount(2);
  await expect(controls.getByRole("heading", { name: "Questions (2)" })).toBeVisible();
  // Text stays text.
  await expect(rows.nth(1).locator(".live-question-text")).toHaveText("<b>Druhá</b> otázka");
  await expect(controls.locator(".live-question-text b")).toHaveCount(0);
  await expect(neighbour.locator(".live-ask .live-count")).toHaveText("2");

  await neighbour.locator(".live-ask").click();
  await neighbour.locator(".live-sheet .live-question").nth(1).locator(".live-vote").click();
  await expect(rows.nth(0)).toContainText("Druhá");
  await expect(rows.nth(0)).toContainText("▲ 2");

  // The vote survives a reload, so it can be taken back rather than cast twice.
  await neighbour.reload();
  await connected(neighbour);
  await neighbour.locator(".live-ask").click();
  const vote = neighbour.locator(".live-sheet .live-question").first().locator(".live-vote");
  await expect(vote).toHaveAttribute("aria-pressed", "true");
  await vote.click();
  await expect(rows.nth(0)).toContainText("Prvá");

  await rows.nth(0).getByRole("button", { name: "Answered" }).click();
  await expect(controls.getByRole("heading", { name: "Questions (1)" })).toBeVisible();
  await expect(rows.nth(1)).toContainText("Prvá");
  await expect(neighbour.locator(".live-sheet .live-question").nth(1)).toContainText("Zodpovedané");

  await rows.nth(1).getByRole("button", { name: "Remove" }).click();
  await expect(neighbour.locator(".live-sheet .live-question")).toHaveCount(1);
});

test("a question records the asker's slide, and the presenter can jump there", async ({ browser, server, deckSlug }) => {
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await connected(controls);
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await connected(viewer);

  await controls.evaluate(() => window.Reveal.slide(4, 0));
  await expect.poll(async () => (await position(viewer)).h).toBe(4);
  await ask(viewer, "K tomuto");
  await expect(controls.locator(".live-panel .live-question")).toHaveCount(1);
  await controls.evaluate(() => window.Reveal.slide(0, 0));
  const printed = await controls.evaluate(() => {
    const reveal = window.Reveal;
    return reveal.getSlides().indexOf(reveal.getSlide(4, 0)!) + 1;
  });
  await controls.getByRole("button", { name: `Slide ${printed}`, exact: true }).click();
  await expect.poll(async () => (await position(controls)).h).toBe(4);
});

test("typing a question doesn't drive the deck, and a question survives a network drop", async ({ browser, server, deckSlug }) => {
  const proxy = new Proxy(server.port);
  await proxy.up();
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await connected(controls);
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${proxy.url}/${deckSlug}`);
  await connected(viewer);

  await viewer.locator(".live-browse").click();
  await viewer.locator(".live-ask").click();
  const before = await position(viewer);
  await viewer.locator(".live-sheet textarea").pressSequentially("space n l", { delay: 5 });
  expect(await position(viewer)).toEqual(before);

  await proxy.down();
  await expect(viewer.locator("html")).toHaveAttribute("data-live-state", "reconnecting");
  await ask(viewer, "Počas výpadku");
  await expect(viewer.locator(".live-sheet .live-question")).toHaveCount(1);
  await viewer.waitForTimeout(100);
  await expect(controls.locator(".live-panel .live-question")).toHaveCount(0);

  await proxy.up();
  await connected(viewer);
  await expect(controls.locator(".live-panel .live-question")).toHaveCount(1);
  await expect(viewer.locator(".live-sheet .live-question")).toHaveCount(1);
  await proxy.down();
});

test("over the limit, the viewer is told and keeps the text", async ({ browser, server, deckSlug }) => {
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await connected(viewer);
  for (let i = 0; i < 5; i++) await ask(viewer, `Otázka ${i}`);
  await expect(viewer.locator(".live-sheet .live-question")).toHaveCount(5);
  await ask(viewer, "Šiesta");
  await expect(viewer.locator(".live-sheet-note")).toHaveText(/príliš rýchlo/);
  await expect(viewer.locator(".live-sheet textarea")).toHaveValue("Šiesta");
  await expect(viewer.locator(".live-sheet .live-question")).toHaveCount(5);
});

test("a closed panel shows how many questions came in", async ({ browser, server, deckSlug }) => {
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await connected(controls);
  const viewer = await (await browser.newContext()).newPage();
  await viewer.goto(`${server.url}/${deckSlug}`);
  await connected(viewer);

  await tool(controls, "Toggle side panel");
  await ask(viewer, "Jedna");
  await expect(controls.locator(".live-badge")).toHaveText("1");
  await tool(controls, "Toggle side panel");
  await expect(controls.locator(".live-badge")).toBeHidden();
});

test("the join code shows on the first slide and on demand, never on a phone, and costs no slide", async ({ browser, server, deckSlug }) => {
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await connected(controls);
  const projector = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  await projector.goto(`${server.url}/${deckSlug}`);
  await connected(projector);
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phone.goto(`${server.url}/${deckSlug}`);
  await connected(phone);

  const slides = await projector.evaluate(() => window.Reveal.getTotalSlides());
  const original = (readFileSync(`${import.meta.dirname}/../fixtures/pb016-cv05.html`, "utf8").match(/<section/g) ?? []).length;
  expect(await projector.locator(".reveal .slides section").count()).toBe(original);
  expect(slides).toBeGreaterThan(1);

  const join = projector.locator(".live-join");
  await expect(join).toBeVisible();
  await expect(join).not.toHaveClass(/live-join-full/);
  await expect(join.locator("span")).toHaveText(new URL(server.url).host + `/${deckSlug}`);
  await expect.poll(() => join.locator("img").evaluate((i) => (i as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const { width, height } = (await join.locator("img").boundingBox())!;
  expect(height).toBeGreaterThan(400);
  expect(width).toBeCloseTo(height, 0);
  await expect(phone.locator(".live-join")).toBeHidden();

  await controls.keyboard.press("ArrowRight");
  await expect.poll(async () => (await position(projector)).h).toBe(1);
  await expect(join).toBeHidden();

  // Q raises it for everyone. A viewer joining now sees it too.
  await controls.keyboard.press("q");
  await expect(join).toHaveClass(/live-join-full/);
  await expect(join).toBeVisible();
  await expect(projector.locator(".live-join strong")).toHaveText("Pripojte sa a pýtajte sa");
  await expect(controls.locator(".live-join")).toBeVisible();
  await expect(controls.getByRole("button", { name: "Show join code (Q)" })).toHaveAttribute("aria-pressed", "true");
  await expect(phone.locator(".live-join")).toBeHidden();
  const late = await (await browser.newContext()).newPage();
  await late.goto(`${server.url}/${deckSlug}`);
  await connected(late);
  await expect(late.locator(".live-join")).toBeVisible();

  await tool(controls, "Show join code (Q)");
  await expect(join).toBeHidden();
  await controls.keyboard.press("ArrowLeft");
  await expect(join).toBeVisible();
});

test("the code is public, holds the viewer link, and 404s for an unknown session", async ({ server, deckSlug }) => {
  const response = await fetch(`${server.url}/${deckSlug}/qr.svg`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("image/svg+xml");
  expect(await response.text()).toContain("<svg");
  expect((await fetch(`${server.url}/${nextSlug()}/qr.svg`)).status).toBe(404);
});

test("questions go full screen for the room, replace the join code, and follow votes and answers", async ({ browser, server, deckSlug }) => {
  const controls = await (await presenterContext(browser)).newPage();
  await controls.goto(`${server.url}/controls/${deckSlug}`);
  await connected(controls);
  const projector = await (await browser.newContext()).newPage();
  await projector.goto(`${server.url}/${deckSlug}`);
  await connected(projector);
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await phone.goto(`${server.url}/${deckSlug}`);
  await connected(phone);

  const wall = projector.locator(".live-question-screen");
  await expect(wall).toBeHidden();
  await controls.keyboard.press("q");
  await expect(projector.locator(".live-join-full")).toBeVisible();
  await controls.keyboard.press("w");
  await expect(wall).toBeVisible();
  await expect(projector.locator(".live-join-full")).toHaveCount(0);
  await expect(wall).toContainText("Zatiaľ žiadne otázky.");
  await expect(controls.getByRole("button", { name: "Show questions (W)" })).toHaveAttribute("aria-pressed", "true");
  await expect(controls.getByRole("button", { name: "Show join code (Q)" })).toHaveAttribute("aria-pressed", "false");
  await expect(phone.locator(".live-question-screen")).toBeHidden();

  for (const text of ["Jedna", "Dve", "<b>Tri</b>", "Štyri", "Päť"]) await ask(phone, text);
  await ask(projector, "Šesť");
  await expect(wall.locator(".live-screen-row")).toHaveCount(5);
  await expect(wall.locator(".live-screen-more")).toHaveText("Ďalšie otázky: 1");
  await expect(wall.locator(".live-screen-text").nth(2)).toHaveText("<b>Tri</b>");

  const panelRows = controls.locator(".live-panel .live-question");
  await expect(panelRows).toHaveCount(6);
  await phone.locator(".live-sheet .live-question").filter({ hasText: "Šesť" }).locator(".live-vote").click();
  await expect(wall.locator(".live-screen-row").first()).toContainText("Šesť");
  await panelRows.first().getByRole("button", { name: "Answered" }).click();
  await expect(wall.locator(".live-screen-row").first()).toContainText("Jedna");
  await expect(wall.locator(".live-screen-more")).toBeHidden();

  // A viewer joining now sees it too.
  const late = await (await browser.newContext()).newPage();
  await late.goto(`${server.url}/${deckSlug}`);
  await connected(late);
  await expect(late.locator(".live-question-screen")).toBeVisible();
  await tool(controls, "Show questions (W)");
  await expect(wall).toBeHidden();
  await expect(late.locator(".live-question-screen")).toBeHidden();
});

test("the full-screen button hides the viewer's controls until full screen ends", async ({ browser, server, deckSlug }) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 }, screen: { width: 1280, height: 720 } })).newPage();
  await page.goto(`${server.url}/${deckSlug}`);
  await connected(page);
  const pill = page.locator(".live-pill");
  // A window that fills the screen is no longer taken as a request for full screen.
  await expect(pill).toBeVisible();
  await page.locator(".live-ask").click();
  await expect(page.locator(".live-sheet")).toBeVisible();

  await page.locator(".live-fullscreen-button").click();
  await expect(pill).toBeHidden();
  await expect(page.locator(".live-sheet")).toBeHidden();
  await page.evaluate(() => document.exitFullscreen());
  await expect(pill).toBeVisible();
});

test("a phone has no full-screen button and keeps its controls", async ({ browser, server, deckSlug }) => {
  const size = { width: 390, height: 844 };
  const phone = await (await browser.newContext({ viewport: size, screen: size })).newPage();
  await phone.goto(`${server.url}/${deckSlug}`);
  await connected(phone);
  await expect(phone.locator(".live-pill")).toBeVisible();
  await expect(phone.locator(".live-fullscreen-button")).toBeHidden();
  await expect(phone.locator("html")).not.toHaveClass(/live-fullscreen/);
});
