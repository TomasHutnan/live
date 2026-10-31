import type { Point, StrokeItem, StrokeStyle, StrokeTool, TextItem } from "../shared/protocol.ts";
import type { Connection } from "./connection.ts";
import { type Ink, uuid } from "./ink.ts";
import type { Overlay } from "./overlay.ts";
import { COORD_DECIMALS, ERASER_RADIUS, PRESSURE_DECIMALS, STROKE_BATCH_MS } from "./tuning.ts";

export type Tool = "navigate" | StrokeTool | "text" | "eraser";

export interface PenSettings {
  tool: Tool;
  color: string;
  width: number;
  textSize: number;
}

const roundTo = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/** Everything a pen, finger or mouse does on the overlay. */
export class Pen {
  private activePointer?: number;
  private penSeen = false;
  private stroke?: StrokeItem;
  private batch: Point[] = [];
  private batchTimer?: ReturnType<typeof setTimeout>;
  private editor?: HTMLTextAreaElement;

  constructor(
    private readonly overlay: Overlay,
    private readonly ink: Ink,
    private readonly connection: Connection,
    private readonly settings: PenSettings,
  ) {
    const { svg } = overlay;
    svg.addEventListener("pointerdown", (e) => this.onDown(e));
    svg.addEventListener("pointermove", (e) => this.onMove(e));
    svg.addEventListener("pointerup", (e) => this.onUp(e));
    svg.addEventListener("pointercancel", (e) => this.onUp(e));
    // The deck must never see these while a tool is active, or a click or a
    // swipe on the ink would advance it. Keyboard events don't pass through here.
    for (const type of ["mousedown", "mouseup", "click", "dblclick", "touchstart", "touchmove", "touchend"]) {
      svg.addEventListener(type, (e) => e.stopPropagation(), { passive: true });
    }
  }

  /** Id of the stroke under the pen, if any. */
  get drawingId(): string | undefined {
    return this.stroke?.id;
  }

  /** Reflects the current tool on the overlay. */
  sync(): void {
    const { tool } = this.settings;
    const { style } = this.overlay.svg;
    style.pointerEvents = tool === "navigate" ? "none" : "auto";
    style.cursor = tool === "text" ? "text" : tool === "eraser" ? "cell" : "crosshair";
    if (tool !== "text") this.commitEditor();
  }

  private ignores(e: PointerEvent): boolean {
    if (e.pointerType === "pen") this.penSeen = true;
    // A resting palm arrives as touch. Once a pen has shown up, touch can't
    // draw, but a finger may still place a text box.
    return e.pointerType === "touch" && this.penSeen && this.settings.tool !== "text";
  }

  private onDown(e: PointerEvent): void {
    e.stopPropagation();
    e.preventDefault();
    if (this.ignores(e) || this.activePointer !== undefined || e.button > 0) return;
    this.activePointer = e.pointerId;
    this.overlay.svg.setPointerCapture(e.pointerId);
    const { tool } = this.settings;
    if (tool === "pen" || tool === "highlighter") this.begin(e, tool);
    else if (tool === "eraser") this.eraseAt(e);
  }

  private onMove(e: PointerEvent): void {
    if (e.pointerId !== this.activePointer) return;
    e.stopPropagation();
    const samples = e.getCoalescedEvents?.() ?? [];
    const events = samples.length ? samples : [e];
    if (this.stroke) this.extend(events.map((sample) => this.point(sample)));
    else if (this.settings.tool === "eraser") for (const sample of events) this.eraseAt(sample);
  }

  private onUp(e: PointerEvent): void {
    if (e.pointerId !== this.activePointer) return;
    e.stopPropagation();
    this.activePointer = undefined;
    if (this.stroke) this.finish();
    // Focus works on iOS only inside the gesture, and pointerup is the end of it.
    else if (this.settings.tool === "text" && e.type === "pointerup") this.openEditor(e);
  }

  private point(e: PointerEvent): Point {
    const { x, y } = this.overlay.toSlide(e.clientX, e.clientY);
    return [
      roundTo(x, COORD_DECIMALS),
      roundTo(y, COORD_DECIMALS),
      e.pointerType === "pen" ? roundTo(e.pressure, PRESSURE_DECIMALS) : 0.5,
    ];
  }

  private begin(e: PointerEvent, tool: StrokeTool): void {
    const { h, v, f } = this.overlay.position();
    const style: StrokeStyle = { tool, color: this.settings.color, width: this.settings.width };
    if (e.pointerType === "pen") style.pen = true;
    const id = uuid();
    const first = this.point(e);
    this.stroke = { id, kind: "stroke", h, v, step: f, data: { ...style, points: [first] } };
    this.overlay.startLive({ id, h, v, step: f, ...style, points: [first] });
    this.connection.send({ t: "stroke.start", stroke: { id, h, v, step: f, ...style } });
    this.batch = [first];
    this.schedule();
  }

  private extend(points: Point[]): void {
    this.stroke!.data.points.push(...points);
    this.overlay.extendLive(this.stroke!.id, points);
    this.batch.push(...points);
    this.schedule();
  }

  private schedule(): void {
    this.batchTimer ??= setTimeout(() => this.flushBatch(), STROKE_BATCH_MS);
  }

  private flushBatch(): void {
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    if (this.stroke && this.batch.length) {
      // Best effort: a lost batch only affects the live preview, because
      // stroke.end carries the whole stroke.
      this.connection.send({ t: "stroke.points", id: this.stroke.id, points: this.batch });
    }
    this.batch = [];
  }

  private finish(): void {
    this.flushBatch();
    const item = this.stroke!;
    this.stroke = undefined;
    this.ink.finishStroke(item);
  }

  private eraseAt(e: PointerEvent): void {
    const { x, y } = this.overlay.toSlide(e.clientX, e.clientY);
    const item = this.overlay.itemAt(x, y, ERASER_RADIUS);
    if (item) this.ink.erase(item);
  }

  // Text boxes. The editor is an HTML textarea inside .slides, so it scales
  // with the deck, and reveal ignores keys while a textarea has focus.

  private openEditor(e: PointerEvent): void {
    if (this.editor) {
      this.commitEditor();
      return;
    }
    const { x, y } = this.overlay.toSlide(e.clientX, e.clientY);
    const { h, v, f } = this.overlay.position();
    const { color, textSize: size } = this.settings;

    const editor = document.createElement("textarea");
    editor.className = "live-text-editor";
    editor.rows = 1;
    editor.style.left = `${(x / this.overlay.width) * 100}%`;
    editor.style.top = `${(y / this.overlay.height) * 100}%`;
    editor.style.fontSize = `${size}px`;
    editor.style.color = color;
    this.overlay.svg.after(editor);
    this.editor = editor;

    const place = { h, v, step: f, x: Math.round(x), y: Math.round(y), size, color };
    const fit = () => {
      editor.style.height = "auto";
      editor.style.height = `${editor.scrollHeight}px`;
    };
    editor.addEventListener("input", fit);
    editor.addEventListener("keydown", (key) => {
      key.stopPropagation();
      if (key.key === "Escape") {
        editor.value = "";
        this.commitEditor();
      } else if (key.key === "Enter" && !key.shiftKey) {
        key.preventDefault();
        this.commitEditor();
      }
    });
    editor.addEventListener("blur", () => this.commitEditor());
    this.commit = () => {
      const text = editor.value.replace(/\s+$/, "");
      if (text) {
        const item: TextItem = {
          id: uuid(),
          kind: "text",
          h: place.h,
          v: place.v,
          step: place.step,
          data: { x: place.x, y: place.y, text, size: place.size, color: place.color },
        };
        this.ink.addText(item);
      }
    };
    fit();
    editor.focus();
  }

  private commit: () => void = () => {};

  commitEditor(): void {
    const editor = this.editor;
    if (!editor) return;
    this.editor = undefined;
    this.commit();
    editor.remove();
  }
}
