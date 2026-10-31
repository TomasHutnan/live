import type { Item, Mutation, Position, ServerMessage, StrokeItem } from "../shared/protocol.ts";
import type { Connection } from "./connection.ts";
import { applyInkMessage, type Overlay } from "./overlay.ts";

type Action =
  | { type: "add"; item: Item }
  | { type: "remove"; item: Item }
  | { type: "clear"; slide: { h: number; v: number }; items: Item[] };

type Draft<M> = M extends unknown ? Omit<M, "m"> : never;

interface Pending {
  message: Mutation;
  /** Set for a restore: the local copy needed to replay it over a snapshot. */
  item?: Item;
}

export function uuid(): string {
  // crypto.randomUUID needs a secure context, and plain http on a LAN isn't one.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * The presenter's ink state. Every change shows locally at once and enters the
 * outbox, which keeps it until the server acknowledges it. Resends are safe
 * because every mutation is idempotent by item id.
 */
export class Ink {
  private readonly outbox = new Map<string, Pending>();
  private readonly undoStack: Action[] = [];
  private readonly redoStack: Action[] = [];
  private authorised = false;
  onChange: () => void = () => {};

  constructor(
    private readonly overlay: Overlay,
    private readonly connection: Connection,
  ) {}

  get pending(): number {
    return this.outbox.size;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  private enqueue(draft: Draft<Mutation>, item?: Item): void {
    const message = { ...draft, m: uuid() } as Mutation;
    this.outbox.set(message.m, { message, item });
    if (this.authorised) this.connection.send(message);
    this.onChange();
  }

  private record(action: Action): void {
    this.undoStack.push(action);
    this.redoStack.length = 0;
    this.onChange();
  }

  // User actions

  finishStroke(item: StrokeItem): void {
    this.overlay.addItem(item);
    this.enqueue({ t: "stroke.end", item });
    this.record({ type: "add", item });
  }

  addText(item: Item): void {
    this.overlay.addItem(item);
    this.enqueue({ t: "item.add", item });
    this.record({ type: "add", item });
  }

  erase(item: Item): void {
    this.remove(item);
    this.record({ type: "remove", item });
  }

  /** Clears the slide being shown. The ids make a resend safe: ink drawn later survives it. */
  clearSlide(at: Position): void {
    const items = this.overlay.allItems().filter((item) => item.h === at.h && item.v === at.v);
    if (items.length === 0) return;
    this.clear({ h: at.h, v: at.v }, items);
    this.record({ type: "clear", slide: { h: at.h, v: at.v }, items });
  }

  private remove(item: Item): void {
    this.overlay.removeItem(item.id);
    this.enqueue({ t: "item.remove", id: item.id });
  }

  private restore(item: Item): void {
    this.overlay.addItem(item);
    this.enqueue({ t: "item.restore", id: item.id }, item);
  }

  private clear(slide: { h: number; v: number }, items: Item[]): void {
    for (const item of items) this.overlay.removeItem(item.id);
    this.enqueue({ t: "slide.clear", slide, ids: items.map((item) => item.id) });
  }

  undo(): void {
    const action = this.undoStack.pop();
    if (!action) return;
    if (action.type === "add") this.remove(action.item);
    else if (action.type === "remove") this.restore(action.item);
    else for (const item of action.items) this.restore(item);
    this.redoStack.push(action);
    this.onChange();
  }

  redo(): void {
    const action = this.redoStack.pop();
    if (!action) return;
    if (action.type === "add") this.restore(action.item);
    else if (action.type === "remove") this.remove(action.item);
    else this.clear(action.slide, action.items);
    this.undoStack.push(action);
    this.onChange();
  }

  // Server events

  /** Takes the server's state, puts unacknowledged changes on top and resends them. */
  onSnapshot(items: Item[], liveStrokes: Extract<ServerMessage, { t: "snapshot" }>["live"], drawingId?: string): void {
    this.overlay.setItems(items);
    this.overlay.setLive(liveStrokes, drawingId);
    for (const { message, item } of this.outbox.values()) this.replay(message, item);
    this.authorised = true;
    for (const { message } of this.outbox.values()) this.connection.send(message);
    this.onChange();
  }

  private replay(message: Mutation, item?: Item): void {
    switch (message.t) {
      case "stroke.end":
      case "item.add":
        this.overlay.addItem(message.item);
        break;
      case "item.remove":
        this.overlay.removeItem(message.id);
        break;
      case "item.restore":
        if (item) this.overlay.addItem(item);
        break;
      case "slide.clear":
        for (const id of message.ids) this.overlay.removeItem(id);
        break;
    }
  }

  onDisconnect(): void {
    this.authorised = false;
  }

  onMessage(message: ServerMessage): void {
    if (message.t === "ack") {
      this.outbox.delete(message.m);
      this.onChange();
      return;
    }
    applyInkMessage(this.overlay, message);
  }
}
