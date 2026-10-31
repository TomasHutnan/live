import { describe, expect, it } from "vitest";
import { isValidSlug, suggestSlug } from "../../src/shared/slug.ts";

describe("isValidSlug", () => {
  it("accepts slugs that fit the pattern", () => {
    for (const slug of ["cv05-a", "ab", "0x", "a-", `a${"b".repeat(40)}`]) expect(isValidSlug(slug)).toBe(true);
  });

  it("rejects bad shapes", () => {
    for (const slug of ["", "a", "-ab", "AB", "a_b", "a b", "á1", "a/b", `a${"b".repeat(41)}`, "ab\n"]) {
      expect(isValidSlug(slug)).toBe(false);
    }
  });

  it("rejects every reserved word", () => {
    for (const slug of ["dashboard", "controls", "api", "ws", "healthz", "assets"]) {
      expect(isValidSlug(slug)).toBe(false);
    }
  });
});

describe("suggestSlug", () => {
  it("builds from the filename and strips diacritics", () => {
    expect(suggestSlug("Cvičenie 05.html", "")).toBe("cvicenie-05-a");
  });

  it("moves past taken slugs", () => {
    expect(suggestSlug("cv05.html", "", new Set(["cv05-a", "cv05-b"]))).toBe("cv05-c");
  });

  it("uses the title for index.html", () => {
    expect(suggestSlug("index.html", "Cvičenie 05")).toBe("cvicenie-05-a");
  });

  it("always yields a valid slug", () => {
    for (const name of ["index.html", "---.html", "x".repeat(99)]) {
      expect(isValidSlug(suggestSlug(name, ""))).toBe(true);
    }
  });
});
