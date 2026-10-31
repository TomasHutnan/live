import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  annotatedDeck,
  CLIENT_TAG,
  deckTitle,
  hasRevealInitialize,
  insertBeforeBodyEnd,
  jsonForScript,
  relativeReferences,
} from "../../src/server/inject.ts";

const fixture = readFileSync(new URL("../fixtures/pb016-cv05.html", import.meta.url), "utf8");

describe("insertBeforeBodyEnd", () => {
  it("inserts before the last </body> when several exist", () => {
    const html = `<body><script>let a = "</body>";</script><p>x</p></body></html>`;
    expect(insertBeforeBodyEnd(html, "[X]")).toBe(`<body><script>let a = "</body>";</script><p>x</p>[X]</body></html>`);
  });

  it("works across newlines, in upper case and with a space in the tag", () => {
    expect(insertBeforeBodyEnd("a</body>\nb</BODY >\n", "[X]")).toBe("a</body>\nb[X]</BODY >\n");
  });

  it("takes a snippet with $ patterns literally", () => {
    expect(insertBeforeBodyEnd("a</body>", "$&$1")).toBe("a$&$1</body>");
  });

  it("appends when there is no </body>", () => {
    expect(insertBeforeBodyEnd("<p>a", "[X]")).toBe("<p>a[X]");
  });

  it("handles the real deck: two </body> lines, injected at the end", () => {
    expect(fixture.split("</body>").length - 1).toBeGreaterThanOrEqual(2);
    const out = insertBeforeBodyEnd(fixture, CLIENT_TAG);
    expect(out.length).toBe(fixture.length + CLIENT_TAG.length);
    expect(out.endsWith(`${CLIENT_TAG}</body></html>\n`) || out.trimEnd().endsWith(`${CLIENT_TAG}</body></html>`)).toBe(true);
    expect(out.indexOf(CLIENT_TAG)).toBeGreaterThan(out.indexOf("Reveal.initialize"));
  });
});

describe("deck inspection", () => {
  it("finds Reveal.initialize and the title in the real deck", () => {
    expect(hasRevealInitialize(fixture)).toBe(true);
    expect(deckTitle(fixture)).toBe("Cvičenie 05");
  });

  it("rejects HTML without Reveal.initialize", () => {
    expect(hasRevealInitialize("<html><body>hello</body></html>")).toBe(false);
  });

  it("finds no relative references in the embedded deck", () => {
    expect(relativeReferences(fixture)).toEqual([]);
  });

  it("reports relative references, ignoring URLs, anchors and script text", () => {
    const html = `
      <script src="lib/reveal.js"></script>
      <link rel="stylesheet" href="./a.css">
      <img src="data:image/png;base64,AA"><img src="https://x.test/a.png"><img src="figures/b.png">
      <img data-src="figures/c.png">
      <a href="other.html">link</a>
      <script>const s = '<img src="not-a-ref.png">';</script>`;
    expect(relativeReferences(html).sort()).toEqual(["./a.css", "figures/b.png", "figures/c.png", "lib/reveal.js"]);
  });
});

describe("annotated export", () => {
  it("escapes every < in the embedded data, so ink text can't end the script", () => {
    const text = "</script><script>alert(1)</script><!--";
    const json = jsonForScript({ items: [{ text }] });
    expect(json).not.toContain("<");
    expect((JSON.parse(json) as { items: { text: string }[] }).items[0]?.text).toBe(text);
  });

  it("starts from the original deck and adds data and runtime before the last </body>", () => {
    const out = annotatedDeck('<body>"</body>"<p>x</p></body></html>', { items: [] }, "RUNTIME");
    expect(out).toBe(
      '<body>"</body>"<p>x</p><script type="application/json" id="live-data">{"items":[]}</script>\n<script>RUNTIME</script>\n</body></html>',
    );
    expect(out).not.toContain("live-client");
  });
});
