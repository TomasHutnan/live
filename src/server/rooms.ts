import { randomBytes } from "node:crypto";
import {
  CLOSE,
  type LiveStroke,
  type Mutation,
  type Point,
  type Position,
  PRESENTER_TYPES,
  PROTOCOL_VERSION,
  type PresenterMessage,
  presenterValidators,
  type Screen,
  type ServerMessage,
  type ViewerQuestionMessage,
  viewerValidators,
} from "../shared/protocol.ts";
import type { Store } from "./store.ts";

const TOKEN_TTL_MS = 60_000;

// Per connection. A university shares one IP, so these can't be per address.
const LIMIT_WINDOW_MS = 60_000;
const ASKS_PER_WINDOW = 5;
const VOTES_PER_WINDOW = 60;
/** Stops a script that keeps reconnecting from filling the database. */
const MAX_QUESTIONS_PER_SESSION = 500;

type Outgoing = ServerMessage extends infer M ? (M extends unknown ? Omit<M, "v"> : never) : never;

/** The part of a WebSocket that rooms need. */
export interface Socket {
  send(data: string): void;
  close(code: number, reason: string): void;
  terminate(): void;
  ping(): void;
}

export class Peer {
  role: "viewer" | "presenter" = "viewer";
  received = 0;
  alive = true;
  readonly strokes = new Set<string>();
  readonly recentAsks: number[] = [];
  readonly recentVotes: number[] = [];

  constructor(
    readonly socket: Socket,
    readonly room: Room,
  ) {}

  send(message: Outgoing): void {
    this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, ...message }));
  }

  reject(code: number, reason: string): void {
    this.socket.close(code, reason);
  }
}

/** Records a hit and says whether it fits in the window. Refused hits don't count. */
function withinLimit(recent: number[], now: number, limit: number): boolean {
  while (recent.length > 0 && recent[0]! <= now - LIMIT_WINDOW_MS) recent.shift();
  if (recent.length >= limit) return false;
  recent.push(now);
  return true;
}

class Room {
  /** What is up over the deck. Ends with the room. */
  screen: Screen = null;
  readonly peers = new Set<Peer>();
  readonly live = new Map<string, LiveStroke & { owner: Peer }>();

  constructor(
    readonly slug: string,
    public position: Position,
    readonly title: string,
  ) {}

  broadcast(message: Outgoing, except?: Peer): void {
    const data = JSON.stringify({ v: PROTOCOL_VERSION, ...message });
    for (const peer of this.peers) if (peer !== except) peer.socket.send(data);
  }

  counts(): { viewers: number; presenters: number } {
    let presenters = 0;
    for (const peer of this.peers) if (peer.role === "presenter") presenters += 1;
    return { viewers: this.peers.size - presenters, presenters };
  }

  announce(): void {
    this.broadcast({ t: "presence", ...this.counts() });
  }
}

type Handler<M> = (room: Room, peer: Peer, message: M) => void;
type Mutating<T extends Mutation["t"]> = Handler<Extract<Mutation, { t: T }>>;
type Ask = Extract<ViewerQuestionMessage, { t: "question.ask" }>;
type Vote = Extract<ViewerQuestionMessage, { t: "question.vote" }>;

export class Rooms {
  private readonly rooms = new Map<string, Room>();
  private readonly tokens = new Map<string, { slug: string; expires: number }>();

  constructor(
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {}

  // Dispatch tables, one per role. A new message type is one new entry here.
  // Everything a viewer can ever trigger goes through viewerHandlers.

  private readonly viewerHandlers: Record<string, Handler<Record<string, unknown>>> = {
    ping: (_room, peer) => peer.send({ t: "pong" }),
    auth: (room, peer, message) => this.authenticate(room, peer, message),
    "question.ask": (room, peer, message) => this.onAsk(room, peer, message as unknown as Ask),
    "question.vote": (room, peer, message) => this.onVote(room, peer, message as unknown as Vote),
  };

  private readonly presenterHandlers: { [T in PresenterMessage["t"]]: Handler<Extract<PresenterMessage, { t: T }>> } & {
    ping: Handler<unknown>;
  } = {
    ping: (_room, peer) => peer.send({ t: "pong" }),
    position: (room, peer, m) => this.onPosition(room, peer, m),
    "stroke.start": (room, peer, m) => this.onStrokeStart(room, peer, m),
    "stroke.points": (room, peer, m) => this.onStrokePoints(room, peer, m),
    "stroke.end": (room, peer, m) => this.onStrokeEnd(room, peer, m),
    "item.add": (room, peer, m) => this.onItemAdd(room, peer, m),
    "item.remove": (room, peer, m) => this.onItemRemove(room, peer, m),
    "item.restore": (room, peer, m) => this.onItemRestore(room, peer, m),
    "slide.clear": (room, peer, m) => this.onSlideClear(room, peer, m),
    "question.answer": (room, peer, m) => this.onAnswer(room, peer, m),
    "question.remove": (room, peer, m) => this.onQuestionRemove(room, peer, m),
    screen: (room, peer, m) => this.onScreen(room, peer, m),
  };

  // Tokens

  issueToken(slug: string): string {
    const now = this.now();
    for (const [token, entry] of this.tokens) if (entry.expires <= now) this.tokens.delete(token);
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, { slug, expires: now + TOKEN_TTL_MS });
    return token;
  }

  private spendToken(token: unknown, slug: string): boolean {
    if (typeof token !== "string") return false;
    const entry = this.tokens.get(token);
    if (!entry) return false;
    this.tokens.delete(token);
    return entry.slug === slug && entry.expires > this.now();
  }

  // Connections

  join(slug: string, socket: Socket): Peer | undefined {
    const session = this.store.session(slug);
    if (!session) {
      socket.close(CLOSE.noSession, "no such session");
      return undefined;
    }
    let room = this.rooms.get(slug);
    if (!room) {
      room = new Room(slug, session.position, session.title);
      this.rooms.set(slug, room);
    }
    const peer = new Peer(socket, room);
    room.peers.add(peer);
    this.sendSnapshot(room, peer);
    room.announce();
    return peer;
  }

  private sendSnapshot(room: Room, peer: Peer): void {
    peer.send({
      t: "snapshot",
      role: peer.role,
      position: room.position,
      items: this.store.liveItems(room.slug),
      live: [...room.live.values()].map(({ owner: _owner, ...stroke }) => stroke),
      viewers: room.counts().viewers,
      session: { title: room.title, state: "active" },
      questions: this.store.questions(room.slug),
      screen: room.screen,
    });
  }

  leave(peer: Peer): void {
    const room = peer.room;
    if (!room.peers.delete(peer)) return;
    // The presenter's outbox still holds these. Drop the half-drawn copies
    // until the finished items arrive.
    // A reconnected presenter may already have finished one on a new socket,
    // which is why only strokes still in progress are dropped.
    for (const id of peer.strokes) {
      if (room.live.delete(id)) room.broadcast({ t: "item.remove", id });
    }
    if (room.peers.size === 0) this.rooms.delete(room.slug);
    else room.announce();
  }

  receive(peer: Peer, raw: string): void {
    peer.received += 1;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      peer.reject(CLOSE.invalid, "not JSON");
      return;
    }
    if (typeof message !== "object" || message === null || message.v !== PROTOCOL_VERSION) {
      peer.reject(CLOSE.invalid, "bad version");
      return;
    }
    const type = message.t;
    if (typeof type !== "string") {
      peer.reject(CLOSE.invalid, "no type");
      return;
    }

    if (peer.role === "viewer") {
      const handler = Object.hasOwn(this.viewerHandlers, type) ? this.viewerHandlers[type] : undefined;
      const validate = Object.hasOwn(viewerValidators, type)
        ? viewerValidators[type as ViewerQuestionMessage["t"]]
        : undefined;
      if (validate && !validate(message)) peer.reject(CLOSE.invalid, "malformed message");
      else if (handler) handler(peer.room, peer, message);
      else if (PRESENTER_TYPES.has(type)) peer.reject(CLOSE.forbidden, "presenter message from a viewer");
      else peer.reject(CLOSE.invalid, "unknown type");
      return;
    }

    if (!Object.hasOwn(this.presenterHandlers, type)) {
      peer.reject(CLOSE.invalid, "unknown type");
      return;
    }
    const validate = presenterValidators[type as PresenterMessage["t"]];
    if (validate && !validate(message)) {
      peer.reject(CLOSE.invalid, "malformed message");
      return;
    }
    const handler = this.presenterHandlers[type as PresenterMessage["t"]] as Handler<unknown>;
    handler(peer.room, peer, message);
  }

  private authenticate(room: Room, peer: Peer, message: Record<string, unknown>): void {
    if (peer.received !== 1 || !this.spendToken(message.token, room.slug)) {
      peer.reject(CLOSE.badToken, "bad token");
      return;
    }
    peer.role = "presenter";
    this.sendSnapshot(room, peer);
    room.announce();
  }

  // Viewer handlers

  private onAsk(room: Room, peer: Peer, { m, question, voter }: Ask): void {
    // A resend after a dropped ack, which must not spend the sender's allowance.
    if (this.store.questionExists(question.id)) {
      peer.send({ t: "ack", m });
      return;
    }
    if (!withinLimit(peer.recentAsks, this.now(), ASKS_PER_WINDOW)) {
      peer.send({ t: "question.rejected", m, reason: "rate" });
      return;
    }
    if (this.store.questionCount(room.slug) >= MAX_QUESTIONS_PER_SESSION) {
      peer.send({ t: "question.rejected", m, reason: "full" });
      return;
    }
    const { id, text, slide } = question;
    const added = this.store.addQuestion(room.slug, id, text.trim(), slide.h, slide.v, voter);
    room.broadcast({ t: "question.add", question: added });
    peer.send({ t: "ack", m });
  }

  private onVote(room: Room, peer: Peer, { m, id, voter, on }: Vote): void {
    if (!withinLimit(peer.recentVotes, this.now(), VOTES_PER_WINDOW)) {
      peer.send({ t: "question.rejected", m, reason: "rate" });
      return;
    }
    const question = this.store.setVote(room.slug, id, voter, on);
    if (question) room.broadcast({ t: "question.update", question });
    peer.send({ t: "ack", m });
  }

  // Presenter handlers

  private onPosition(room: Room, peer: Peer, { m, position }: { m: string; position: Position }): void {
    const { h, v, f } = position;
    room.position = { h, v, f };
    this.store.setPosition(room.slug, room.position);
    room.broadcast({ t: "position", position: room.position }, peer);
    peer.send({ t: "ack", m });
  }

  private onStrokeStart(room: Room, peer: Peer, message: Extract<PresenterMessage, { t: "stroke.start" }>): void {
    const { stroke } = message;
    if (room.live.has(stroke.id)) return;
    room.live.set(stroke.id, { ...stroke, points: [], owner: peer });
    peer.strokes.add(stroke.id);
    room.broadcast({ t: "stroke.start", stroke }, peer);
  }

  private onStrokePoints(room: Room, peer: Peer, message: { id: string; points: Point[] }): void {
    const stroke = room.live.get(message.id);
    if (!stroke) return;
    stroke.points.push(...message.points);
    room.broadcast({ t: "stroke.points", id: message.id, points: message.points }, peer);
  }

  private onStrokeEnd: Mutating<"stroke.end"> = (room, peer, { m, item }) => {
    room.live.delete(item.id);
    peer.strokes.delete(item.id);
    if (this.store.addItem(room.slug, item)) room.broadcast({ t: "item.add", item }, peer);
    peer.send({ t: "ack", m });
  };

  private onItemAdd: Mutating<"item.add"> = (room, peer, { m, item }) => {
    if (this.store.addItem(room.slug, item)) room.broadcast({ t: "item.add", item }, peer);
    peer.send({ t: "ack", m });
  };

  private onItemRemove: Mutating<"item.remove"> = (room, peer, { m, id }) => {
    if (this.store.removeItem(room.slug, id)) room.broadcast({ t: "item.remove", id }, peer);
    peer.send({ t: "ack", m });
  };

  private onItemRestore: Mutating<"item.restore"> = (room, peer, { m, id }) => {
    const item = this.store.restoreItem(room.slug, id);
    if (item) room.broadcast({ t: "item.restore", item }, peer);
    peer.send({ t: "ack", m });
  };

  private onSlideClear: Mutating<"slide.clear"> = (room, peer, { m, slide, ids }) => {
    const cleared = this.store.clearItems(room.slug, slide.h, slide.v, ids);
    if (cleared.length) room.broadcast({ t: "slide.clear", slide, ids: cleared }, peer);
    peer.send({ t: "ack", m });
  };

  private onAnswer(room: Room, peer: Peer, { m, id, answered }: { m: string; id: string; answered: boolean }): void {
    const question = this.store.setAnswered(room.slug, id, answered);
    if (question) room.broadcast({ t: "question.update", question });
    peer.send({ t: "ack", m });
  }

  private onQuestionRemove(room: Room, peer: Peer, { m, id }: { m: string; id: string }): void {
    if (this.store.removeQuestion(room.slug, id)) room.broadcast({ t: "question.remove", id });
    peer.send({ t: "ack", m });
  }

  private onScreen(room: Room, peer: Peer, { m, screen }: { m: string; screen: Screen }): void {
    room.screen = screen;
    room.broadcast({ t: "screen", screen }, peer);
    peer.send({ t: "ack", m });
  }

  // Lifecycle

  counts(slug: string): { viewers: number; presenters: number } {
    return this.rooms.get(slug)?.counts() ?? { viewers: 0, presenters: 0 };
  }

  removed(slug: string): void {
    const room = this.rooms.get(slug);
    if (!room) return;
    room.broadcast({ t: "session.removed" });
    for (const peer of room.peers) peer.reject(CLOSE.removed, "session removed");
    this.rooms.delete(slug);
  }

  /** One beat: pings every socket and drops those that missed the last ping. */
  heartbeat(): void {
    for (const room of this.rooms.values()) {
      for (const peer of room.peers) {
        if (!peer.alive) {
          peer.socket.terminate();
          continue;
        }
        peer.alive = false;
        peer.socket.ping();
      }
    }
  }
}
