import { getStroke } from "perfect-freehand";
import type { Item, LiveStroke, Point, Position, ServerMessage, StrokeData, TextData } from "../shared/protocol.ts";
import { isItemVisible } from "../shared/step.ts";
import { onNavigation, readPosition, type RevealApi } from "./reveal.ts";
import { HIGHLIGHTER_OPACITY, HIGHLIGHTER_SHAPE, HIGHLIGHTER_WIDTH_FACTOR, PEN_SHAPE } from "./tuning.ts";

const SVG_NS = "http://www.w3.org/2000/svg";
const LINE_HEIGHT = 1.2;

function strokeWidth(data: { tool: string; width: number }): number {
  return data.tool === "highlighter" ? data.width * HIGHLIGHTER_WIDTH_FACTOR : data.width;
}

function outlinePath(data: StrokeData): string {
  const shape = data.tool === "highlighter" ? HIGHLIGHTER_SHAPE : PEN_SHAPE;
  const outline = getStroke(data.points, {
    ...shape,
    size: strokeWidth(data) * shape.size,
    simulatePressure: !data.pen,
    last: true,
  });
  if (outline.length === 0) return "";
  const f = (n: number) => n.toFixed(1);
  const start = outline[0]!;
  let d = `M${f(start[0])} ${f(start[1])}Q`;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    d += `${f(a[0])} ${f(a[1])} ${f((a[0] + b[0]) / 2)} ${f((a[1] + b[1]) / 2)} `;
  }
  return `${d}Z`;
}

function drawStroke(group: SVGGElement, data: StrokeData): void {
  let path = group.firstElementChild as SVGPathElement | null;
  if (!path) {
    path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("fill", data.color);
    if (data.tool === "highlighter") path.setAttribute("opacity", String(HIGHLIGHTER_OPACITY));
    group.append(path);
  }
  path.setAttribute("d", outlinePath(data));
}

function drawText(group: SVGGElement, data: TextData): void {
  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("x", String(data.x));
  text.setAttribute("y", String(data.y));
  text.setAttribute("fill", data.color);
  text.setAttribute("font-size", String(data.size));
  text.style.whiteSpace = "pre";
  text.style.fontFamily = "inherit"; // The deck's own font.
  for (const [index, line] of data.text.split("\n").entries()) {
    const span = document.createElementNS(SVG_NS, "tspan");
    span.setAttribute("x", String(data.x));
    span.setAttribute("dy", `${index === 0 ? 1 : LINE_HEIGHT}em`);
    span.textContent = line || " ";
    text.append(span);
  }
  group.append(text);
}

function distanceToSegment(px: number, py: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSquared));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/** True when a pointer at (x, y) with the given reach touches the stroke. */
export function strokeHit(data: StrokeData, x: number, y: number, reach: number): boolean {
  const limit = reach + strokeWidth(data) / 2;
  const { points } = data;
  if (points.length === 1) return Math.hypot(x - points[0]![0], y - points[0]![1]) <= limit;
  for (let i = 1; i < points.length; i++) {
    if (distanceToSegment(x, y, points[i - 1]!, points[i]!) <= limit) return true;
  }
  return false;
}

interface LiveEntry {
  stroke: LiveStroke;
  group: SVGGElement;
}

/**
 * The ink layer: one SVG inside .slides, so reveal's scaling applies to it,
 * with a viewBox of the configured slide size. It draws the current state and
 * knows nothing about servers, so the live client and the export share it.
 */
export class Overlay {
  readonly svg: SVGSVGElement;
  readonly width: number;
  readonly height: number;
  private readonly slides: HTMLElement;
  private readonly items = new Map<string, Item>();
  private readonly groups = new Map<string, SVGGElement>();
  private readonly live = new Map<string, LiveEntry>();

  constructor(private readonly reveal: RevealApi) {
    const config = reveal.getConfig();
    const computed = reveal.getComputedSlideSize();
    this.width = typeof config.width === "number" ? config.width : computed.width;
    this.height = typeof config.height === "number" ? config.height : computed.height;
    this.slides = reveal.getSlidesElement();

    this.svg = document.createElementNS(SVG_NS, "svg");
    this.svg.id = "live-overlay";
    this.svg.setAttribute("viewBox", `0 0 ${this.width} ${this.height}`);
    this.svg.setAttribute("data-prevent-swipe", "");
    this.svg.setAttribute("aria-hidden", "true");
    // Inline, because the deck's own rules for svg must not reach this element.
    this.svg.style.cssText =
      "position:absolute;left:0;top:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;" +
      "z-index:1000;pointer-events:none;touch-action:none;user-select:none;-webkit-user-select:none;" +
      "-webkit-touch-callout:none";
    this.slides.append(this.svg);

    onNavigation(reveal, () => this.refresh());
    reveal.on("overviewshown", () => this.refresh());
    reveal.on("overviewhidden", () => this.refresh());
  }

  position(): Position {
    return readPosition(this.reveal);
  }

  /** Converts a viewport position to slide coordinates. */
  toSlide(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.slides.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * this.width,
      y: ((clientY - rect.top) / rect.height) * this.height,
    };
  }

  /** Scale from slide units to CSS pixels. */
  scale(): number {
    return this.slides.getBoundingClientRect().width / this.width;
  }

  allItems(): Item[] {
    return [...this.items.values()];
  }

  setItems(items: Item[]): void {
    this.items.clear();
    for (const item of items) this.items.set(item.id, item);
    this.refresh();
  }

  addItem(item: Item): void {
    this.dropLive(item.id);
    this.items.set(item.id, item);
    this.refresh();
  }

  removeItem(id: string): void {
    this.dropLive(id);
    this.items.delete(id);
    this.groups.get(id)?.remove();
    this.groups.delete(id);
    this.refresh();
  }

  /** Replaces the strokes in progress, keeping the one under the local pen. */
  setLive(strokes: LiveStroke[], keepId?: string): void {
    for (const id of [...this.live.keys()]) if (id !== keepId) this.dropLive(id);
    for (const stroke of strokes) {
      if (stroke.id === keepId) continue;
      this.startLive(stroke);
    }
  }

  startLive(stroke: LiveStroke): void {
    if (this.items.has(stroke.id) || this.live.has(stroke.id)) return;
    const group = this.newGroup(stroke.id, "stroke");
    this.live.set(stroke.id, { stroke, group });
    drawStroke(group, stroke);
    this.refresh();
  }

  extendLive(id: string, points: Point[]): void {
    const entry = this.live.get(id);
    if (!entry) return;
    entry.stroke.points.push(...points);
    drawStroke(entry.group, entry.stroke);
  }

  private dropLive(id: string): void {
    this.live.get(id)?.group.remove();
    this.live.delete(id);
  }

  /** The topmost visible item within reach of a slide position. */
  itemAt(x: number, y: number, reach: number): Item | undefined {
    const at = this.position();
    const visible = this.allItems().filter((item) => isItemVisible(item, at));
    for (const item of visible.reverse()) {
      if (item.kind === "stroke") {
        if (strokeHit(item.data, x, y, reach)) return item;
      } else {
        const box = this.groups.get(item.id)?.getBBox();
        if (box && x >= box.x - reach && x <= box.x + box.width + reach && y >= box.y - reach && y <= box.y + box.height + reach) {
          return item;
        }
      }
    }
    return undefined;
  }

  private newGroup(id: string, kind: string): SVGGElement {
    const group = document.createElementNS(SVG_NS, "g");
    group.dataset.itemId = id;
    group.dataset.kind = kind;
    return group;
  }

  /** Elements are made on first sight, so a long session doesn't slow down a phone that just joined. */
  private groupFor(item: Item): SVGGElement {
    let group = this.groups.get(item.id);
    if (!group) {
      group = this.newGroup(item.id, item.kind);
      if (item.kind === "stroke") drawStroke(group, item.data);
      else drawText(group, item.data);
      this.groups.set(item.id, group);
    }
    return group;
  }

  /** Applies the step rule for the deck's current position. */
  refresh(): void {
    if (this.reveal.isOverview()) {
      this.svg.replaceChildren();
      return;
    }
    const at = this.position();
    const shown: SVGGElement[] = [];
    for (const item of this.items.values()) if (isItemVisible(item, at)) shown.push(this.groupFor(item));
    for (const { stroke, group } of this.live.values()) if (isItemVisible(stroke, at)) shown.push(group);
    this.svg.replaceChildren(...shown);
  }
}

/** Applies a server message about ink. Returns false for anything else. */
export function applyInkMessage(overlay: Overlay, message: ServerMessage): boolean {
  switch (message.t) {
    case "stroke.start":
      overlay.startLive({ ...message.stroke, points: [] });
      return true;
    case "stroke.points":
      overlay.extendLive(message.id, message.points);
      return true;
    case "item.add":
    case "item.restore":
      overlay.addItem(message.item);
      return true;
    case "item.remove":
      overlay.removeItem(message.id);
      return true;
    case "slide.clear":
      for (const id of message.ids) overlay.removeItem(id);
      return true;
    default:
      return false;
  }
}
