// Wire format of the realtime channel. Every message is JSON with `v` and `t`.
// Coordinates are slide coordinates, in the deck's configured width and height.

export const PROTOCOL_VERSION = 1;

export interface Position {
  h: number;
  v: number;
  /** Normalised step: -1 when no fragment is shown. */
  f: number;
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
