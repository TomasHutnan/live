import { describe, expect, it } from "vitest";
import { isItemVisible, normaliseStep } from "../../src/shared/step.ts";

describe("normaliseStep", () => {
  it("maps a slide without fragments to -1 and keeps real steps", () => {
    expect(normaliseStep(undefined)).toBe(-1);
    expect(normaliseStep(null)).toBe(-1);
    expect(normaliseStep(-1)).toBe(-1);
    expect(normaliseStep(0)).toBe(0);
    expect(normaliseStep(4)).toBe(4);
  });
});

describe("isItemVisible", () => {
  const item = { h: 3, v: 1, step: 2 };

  it("hides the item before its step and shows it from then on", () => {
    expect(isItemVisible(item, { h: 3, v: 1, f: 1 })).toBe(false);
    expect(isItemVisible(item, { h: 3, v: 1, f: 2 })).toBe(true);
    expect(isItemVisible(item, { h: 3, v: 1, f: 3 })).toBe(true);
  });

  it("needs the same slide", () => {
    expect(isItemVisible(item, { h: 2, v: 1, f: 9 })).toBe(false);
    expect(isItemVisible(item, { h: 3, v: 0, f: 9 })).toBe(false);
  });

  it("shows an item drawn before any fragment at every step", () => {
    const first = { h: 0, v: 0, step: -1 };
    expect(isItemVisible(first, { h: 0, v: 0, f: -1 })).toBe(true);
    expect(isItemVisible(first, { h: 0, v: 0, f: 5 })).toBe(true);
  });
});
