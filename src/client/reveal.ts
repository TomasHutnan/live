import type { Position } from "../shared/protocol.ts";
import { normaliseStep } from "../shared/step.ts";

export interface RevealApi {
  isReady(): boolean;
  on(event: string, handler: (event: Event) => void): void;
  getIndices(): { h: number; v: number; f?: number };
  getConfig(): { width: number | string; height: number | string; margin: number; [key: string]: unknown };
  getComputedSlideSize(): { width: number; height: number };
  getRevealElement(): HTMLElement;
  getSlidesElement(): HTMLElement;
  getCurrentSlide(): HTMLElement;
  getSlide(h: number, v?: number): HTMLElement | undefined;
  getTotalSlides(): number;
  slide(h: number, v: number, f?: number): void;
  next(): void;
  prev(): void;
  layout(): void;
  configure(options: Record<string, unknown>): void;
  isOverview(): boolean;
  isPrintView?(): boolean;
}

declare global {
  interface Window {
    Reveal: RevealApi;
  }
}

/** The deck may or may not be ready when the client runs: plugins init asynchronously. */
export function whenReady(reveal: RevealApi, run: () => void): void {
  if (reveal.isReady()) run();
  else reveal.on("ready", run);
}

export function readPosition(reveal: RevealApi): Position {
  const { h, v, f } = reveal.getIndices();
  return { h, v, f: normaliseStep(f) };
}

export const samePosition = (a: Position, b: Position) => a.h === b.h && a.v === b.v && a.f === b.f;

/**
 * Calls `run` after any navigation. Reveal fires several events during one
 * move, some before its state settles, so they coalesce into one microtask.
 */
export function onNavigation(reveal: RevealApi, run: () => void): void {
  let queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      run();
    });
  };
  for (const event of ["slidechanged", "fragmentshown", "fragmenthidden"]) reveal.on(event, notify);
}
