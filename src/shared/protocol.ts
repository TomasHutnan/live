// Wire format of the realtime channel. Every message is JSON with `v`, the
// protocol version, and `t`. Slide indices also use a `v`, so they always sit
// in a nested object, never at the top level of a message.
// Coordinates are slide coordinates, in the deck's configured width and height.

export const PROTOCOL_VERSION = 1;

export interface Position {
  h: number;
  v: number;
  /** Normalised step: -1 when no fragment is shown. */
  f: number;
}

export interface Slide {
  h: number;
  v: number;
}

export type StrokeTool = "pen" | "highlighter";
export type Point = [x: number, y: number, pressure: number];

export interface StrokeStyle {
  tool: StrokeTool;
  color: string;
  width: number;
  /** True when the points carry real pen pressure. */
  pen?: boolean;
}

export interface StrokeData extends StrokeStyle {
  points: Point[];
}

export interface TextData {
  x: number;
  y: number;
  text: string;
  size: number;
  color: string;
}

export type ItemData = StrokeData | TextData;

interface ItemBase {
  id: string;
  h: number;
  v: number;
  step: number;
}
export interface StrokeItem extends ItemBase {
  kind: "stroke";
  data: StrokeData;
}
export interface TextItem extends ItemBase {
  kind: "text";
  data: TextData;
}
export type Item = StrokeItem | TextItem;

/** A stroke still being drawn: it has no item row yet. */
export interface LiveStroke extends ItemBase, StrokeStyle {
  points: Point[];
}

export type SessionState = "active";

// Server to client.
export type ServerMessage = { v: number } & (
  | {
      t: "snapshot";
      role: "viewer" | "presenter";
      position: Position;
      items: Item[];
      live: LiveStroke[];
      viewers: number;
      session: { title: string; state: SessionState };
    }
  | { t: "position"; position: Position }
  | { t: "stroke.start"; stroke: Omit<LiveStroke, "points"> }
  | { t: "stroke.points"; id: string; points: Point[] }
  | { t: "item.add"; item: Item }
  | { t: "item.remove"; id: string }
  | { t: "item.restore"; item: Item }
  | { t: "slide.clear"; slide: Slide; ids: string[] }
  | { t: "presence"; viewers: number; presenters: number }
  | { t: "session.removed" }
  | { t: "ack"; m: string }
  | { t: "pong" }
);

// Client to server. `m` is the sender's id for an outbox entry, echoed in `ack`.
export type Mutation =
  | { t: "stroke.end"; m: string; item: StrokeItem }
  | { t: "item.add"; m: string; item: Item }
  | { t: "item.remove"; m: string; id: string }
  | { t: "item.restore"; m: string; id: string }
  | { t: "slide.clear"; m: string; slide: Slide; ids: string[] };

export type PresenterMessage =
  | { t: "position"; position: Position }
  | { t: "stroke.start"; stroke: Omit<LiveStroke, "points"> }
  | { t: "stroke.points"; id: string; points: Point[] }
  | Mutation;

export type ViewerMessage = { t: "ping" } | { t: "auth"; token: string };

export const PRESENTER_TYPES: ReadonlySet<string> = new Set([
  "position",
  "stroke.start",
  "stroke.points",
  "stroke.end",
  "item.add",
  "item.remove",
  "item.restore",
  "slide.clear",
]);

// Close codes.
export const CLOSE = {
  invalid: 4400,
  badToken: 4401,
  forbidden: 4403,
  noSession: 4404,
  removed: 4410,
} as const;

// Validation. Limits are far above real use: a 7-minute unbroken pen stroke,
// a page of text. They only stop a broken client from filling the database.

const MAX_POINTS = 50_000;
const MAX_TEXT = 4_000;
const MAX_IDS = 20_000;
const MAX_COORD = 100_000;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isIndex = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 1_000_000;
const isStep = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= -1 && (x as number) < 1_000_000;
const isCoord = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= MAX_COORD;
const isId = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x);
const isColor = (x: unknown) => typeof x === "string" && /^#[0-9a-f]{6}$/i.test(x);
const isSize = (x: unknown) => typeof x === "number" && x > 0 && x <= 1000;

const isPoints = (x: unknown): x is Point[] =>
  Array.isArray(x) &&
  x.length <= MAX_POINTS &&
  x.every(
    (p) => Array.isArray(p) && p.length === 3 && isCoord(p[0]) && isCoord(p[1]) && typeof p[2] === "number" && p[2] >= 0 && p[2] <= 1,
  );

function isStyle(x: Record<string, unknown>): boolean {
  return (
    (x.tool === "pen" || x.tool === "highlighter") &&
    isColor(x.color) &&
    isSize(x.width) &&
    (x.pen === undefined || typeof x.pen === "boolean")
  );
}

function hasPlace(x: Record<string, unknown>): boolean {
  return isId(x.id) && isIndex(x.h) && isIndex(x.v) && isStep(x.step);
}

export function isItem(x: unknown): x is Item {
  if (!isObject(x) || !hasPlace(x) || !isObject(x.data)) return false;
  const d = x.data;
  if (x.kind === "stroke") return isStyle(d) && isPoints(d.points) && (d.points as Point[]).length > 0;
  if (x.kind === "text") {
    return (
      isCoord(d.x) &&
      isCoord(d.y) &&
      typeof d.text === "string" &&
      d.text.length > 0 &&
      d.text.length <= MAX_TEXT &&
      isSize(d.size) &&
      isColor(d.color)
    );
  }
  return false;
}

const isSlide = (x: unknown) => isObject(x) && isIndex(x.h) && isIndex(x.v);

const isMsgId = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 64;

export const presenterValidators: Record<PresenterMessage["t"], (m: Record<string, unknown>) => boolean> = {
  position: (m) => isSlide(m.position) && isStep((m.position as Position).f),
  "stroke.start": (m) => isObject(m.stroke) && hasPlace(m.stroke) && isStyle(m.stroke),
  "stroke.points": (m) => isId(m.id) && isPoints(m.points),
  "stroke.end": (m) => isMsgId(m.m) && isItem(m.item) && m.item.kind === "stroke",
  "item.add": (m) => isMsgId(m.m) && isItem(m.item),
  "item.remove": (m) => isMsgId(m.m) && isId(m.id),
  "item.restore": (m) => isMsgId(m.m) && isId(m.id),
  "slide.clear": (m) =>
    isMsgId(m.m) && isSlide(m.slide) && Array.isArray(m.ids) && m.ids.length <= MAX_IDS && m.ids.every(isId),
};
