import type { Position } from "./protocol.ts";

/** A slide with no shown fragments is step -1. */
export function normaliseStep(f: number | undefined | null): number {
  return f ?? -1;
}

/** The ink rule: same slide, and the deck has reached the item's step. */
export function isItemVisible(item: { h: number; v: number; step: number }, at: Position): boolean {
  return item.h === at.h && item.v === at.v && at.f >= item.step;
}
