import { beforeEach, describe, expect, it } from "vitest";
import { etagMatches } from "../../src/server/assets.ts";
import { randomUUID } from "node:crypto";
import { openDb } from "../../src/server/db.ts";
import { type Peer, Rooms, type Socket } from "../../src/server/rooms.ts";
import { Store } from "../../src/server/store.ts";
import { CLOSE, type Item, PROTOCOL_VERSION, type ServerMessage } from "../../src/shared/protocol.ts";

class FakeSocket implements Socket {
  sent: ServerMessage[] = [];
  closed?: number;
  terminated = false;
  pings = 0;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ServerMessage);
  }
  close(code: number) {
    this.closed = code;
  }
  terminate() {
    this.terminated = true;
  }
  ping() {
    this.pings += 1;
  }
  of<T extends ServerMessage["t"]>(type: T) {
    return this.sent.filter((m) => m.t === type) as Extract<ServerMessage, { t: T }>[];
  }
}

const SLUG = "cv05-a";
const text = (overrides: Partial<Item> = {}): Item => ({
  id: randomUUID(),
  kind: "text",
  h: 1,
  v: 0,
  step: 0,
  data: { x: 10, y: 20, text: "ahoj", size: 32, color: "#ff0000" },
  ...overrides,
} as Item);
const stroke = (id = randomUUID()): Item => ({
  id,
  kind: "stroke",
  h: 1,
  v: 0,
  step: 2,
  data: { tool: "pen", color: "#000000", width: 4, points: [[1, 2, 0.5], [3, 4, 0.5]] },
});

describe("rooms", () => {
  let store: Store;
  let rooms: Rooms;
  let now: number;

  beforeEach(() => {
    store = new Store(openDb(":memory:"));
    store.insertDeck({ id: "d", title: "t", filename: "f", hash: "h", size: 1, uploadedAt: 1 });
    store.insertSession(SLUG, "d", "Cvičenie");
    store.insertSession("other", "d", "Other");
    now = 1000;
    rooms = new Rooms(store, () => now);
  });

  const send = (peer: Peer, message: object) =>
    rooms.receive(peer, JSON.stringify({ ...message, v: PROTOCOL_VERSION }));

  function connect(slug = SLUG) {
    const socket = new FakeSocket();
    const peer = rooms.join(slug, socket)!;
    return { socket, peer };
  }

  function presenter(slug = SLUG) {
    const c = connect(slug);
    send(c.peer, { t: "auth", token: rooms.issueToken(slug) });
    expect(c.peer.role).toBe("presenter");
    return c;
  }

  describe("role enforcement", () => {
    it("starts everyone as a viewer", () => {
      const { socket } = connect();
      expect(socket.of("snapshot")[0]?.role).toBe("viewer");
    });

    it.each(["position", "stroke.start", "stroke.points", "stroke.end", "item.add", "item.remove", "item.restore", "slide.clear", "question.answer", "question.remove", "join"])(
      "disconnects a viewer sending %s and changes nothing",
      (t) => {
        const { socket, peer } = connect();
        send(peer, { t, position: { h: 5, v: 0, f: 3 }, m: "1", id: randomUUID(), ids: [], item: text() });
        expect(socket.closed).toBe(CLOSE.forbidden);
        expect(store.session(SLUG)!.position).toEqual({ h: 0, v: 0, f: -1 });
        expect(store.liveItems(SLUG)).toEqual([]);
      },
    );

    it("rejects unknown types for both roles, and prototype keys", () => {
      for (const t of ["poll.start", "constructor", "__proto__", "toString"]) {
        const v = connect();
        send(v.peer, { t });
        expect(v.socket.closed).toBe(CLOSE.invalid);
        const p = presenter();
        send(p.peer, { t });
        expect(p.socket.closed).toBe(CLOSE.invalid);
      }
    });

    it("rejects a wrong version and non-JSON", () => {
      const a = connect();
      rooms.receive(a.peer, JSON.stringify({ v: 99, t: "ping" }));
      expect(a.socket.closed).toBe(CLOSE.invalid);
      const b = connect();
      rooms.receive(b.peer, "{nope");
      expect(b.socket.closed).toBe(CLOSE.invalid);
    });

    it("answers ping for viewers without side effects", () => {
      const { socket, peer } = connect();
      send(peer, { t: "ping" });
      expect(socket.of("pong")).toHaveLength(1);
      expect(socket.closed).toBeUndefined();
    });

    it("disconnects a presenter sending a malformed mutation", () => {
      const { socket, peer } = presenter();
      send(peer, { t: "item.add", m: "1", item: { ...text(), data: { text: 1 } } });
      expect(socket.closed).toBe(CLOSE.invalid);
    });
  });

  describe("tokens", () => {
    it("are single-use", () => {
      const token = rooms.issueToken(SLUG);
      const a = connect();
      send(a.peer, { t: "auth", token });
      expect(a.peer.role).toBe("presenter");
      const b = connect();
      send(b.peer, { t: "auth", token });
      expect(b.peer.role).toBe("viewer");
      expect(b.socket.closed).toBe(CLOSE.badToken);
    });

    it("expire after 60 seconds", () => {
      const token = rooms.issueToken(SLUG);
      now += 60_001;
      const { peer, socket } = connect();
      send(peer, { t: "auth", token });
      expect(socket.closed).toBe(CLOSE.badToken);
    });

    it("are bound to one slug", () => {
      const { peer, socket } = connect("other");
      send(peer, { t: "auth", token: rooms.issueToken(SLUG) });
      expect(peer.role).toBe("viewer");
      expect(socket.closed).toBe(CLOSE.badToken);
    });

    it("work only as the first message", () => {
      const { peer, socket } = connect();
      send(peer, { t: "ping" });
      send(peer, { t: "auth", token: rooms.issueToken(SLUG) });
      expect(peer.role).toBe("viewer");
      expect(socket.closed).toBe(CLOSE.badToken);
    });
  });

  describe("idempotent mutations", () => {
    it("item.add stores once, broadcasts once and always acks", () => {
      const p = presenter();
      const v = connect();
      const item = text();
      send(p.peer, { t: "item.add", m: "a", item });
      send(p.peer, { t: "item.add", m: "b", item });
      expect(store.liveItems(SLUG)).toHaveLength(1);
      expect(v.socket.of("item.add")).toHaveLength(1);
      expect(p.socket.of("ack").map((a) => a.m)).toEqual(["a", "b"]);
    });

    it("a resent stroke.end stores once", () => {
      const p = presenter();
      const item = stroke();
      send(p.peer, { t: "stroke.end", m: "a", item });
      send(p.peer, { t: "stroke.end", m: "a", item });
      expect(store.liveItems(SLUG)).toHaveLength(1);
      expect(p.socket.of("ack")).toHaveLength(2);
    });

    it("a late resend does not bring back a removed item", () => {
      const p = presenter();
      const item = text();
      send(p.peer, { t: "item.add", m: "a", item });
      send(p.peer, { t: "item.remove", m: "b", id: item.id });
      send(p.peer, { t: "item.add", m: "a", item });
      expect(store.liveItems(SLUG)).toEqual([]);
    });

    it("remove and restore are idempotent", () => {
      const p = presenter();
      const v = connect();
      const item = text();
      send(p.peer, { t: "item.add", m: "a", item });
      send(p.peer, { t: "item.remove", m: "b", id: item.id });
      send(p.peer, { t: "item.remove", m: "c", id: item.id });
      expect(v.socket.of("item.remove")).toHaveLength(1);
      send(p.peer, { t: "item.restore", m: "d", id: item.id });
      send(p.peer, { t: "item.restore", m: "e", id: item.id });
      expect(v.socket.of("item.restore")).toHaveLength(1);
      expect(v.socket.of("item.restore")[0]?.item.id).toBe(item.id);
      expect(store.liveItems(SLUG)).toHaveLength(1);
    });

    it("slide.clear touches only the named items, on that slide", () => {
      const p = presenter();
      const v = connect();
      const named = text();
      const elsewhere = text({ h: 2 });
      const newer = text();
      for (const item of [named, elsewhere, newer]) send(p.peer, { t: "item.add", m: item.id, item });
      send(p.peer, { t: "slide.clear", m: "c", slide: { h: 1, v: 0 }, ids: [named.id, elsewhere.id] });
      send(p.peer, { t: "slide.clear", m: "c", slide: { h: 1, v: 0 }, ids: [named.id, elsewhere.id] });
      expect(store.liveItems(SLUG).map((i) => i.id).sort()).toEqual([elsewhere.id, newer.id].sort());
      expect(v.socket.of("slide.clear")).toEqual([expect.objectContaining({ ids: [named.id] })]);
    });

    it("cannot touch another session's item", () => {
      const a = presenter();
      const b = presenter("other");
      const item = text();
      send(a.peer, { t: "item.add", m: "a", item });
      send(b.peer, { t: "item.remove", m: "b", id: item.id });
      expect(store.liveItems(SLUG)).toHaveLength(1);
    });
  });

  describe("state", () => {
    it("persists the position and tells everyone else", () => {
      const p = presenter();
      const v = connect();
      send(p.peer, { t: "position", m: "p", position: { h: 3, v: 1, f: 2 } });
      expect(store.session(SLUG)!.position).toEqual({ h: 3, v: 1, f: 2 });
      expect(v.socket.of("position")[0]).toMatchObject({ position: { h: 3, v: 1, f: 2 } });
      expect(p.socket.of("position")).toHaveLength(0);
      expect(p.socket.of("ack").map((a) => a.m)).toEqual(["p"]);
    });

    it("gives a late joiner position, items and strokes in progress", () => {
      const p = presenter();
      const item = text();
      send(p.peer, { t: "position", m: "p", position: { h: 1, v: 0, f: 0 } });
      send(p.peer, { t: "item.add", m: "a", item });
      const id = randomUUID();
      send(p.peer, { t: "stroke.start", stroke: { id, h: 1, v: 0, step: 0, tool: "pen", color: "#000000", width: 4 } });
      send(p.peer, { t: "stroke.points", id, points: [[1, 1, 0.5]] });
      const late = connect().socket.of("snapshot")[0]!;
      expect(late.position).toEqual({ h: 1, v: 0, f: 0 });
      expect(late.items.map((i) => i.id)).toEqual([item.id]);
      expect(late.live[0]).toMatchObject({ id, points: [[1, 1, 0.5]] });
    });

    it("drops half-drawn strokes when their presenter goes away", () => {
      const p = presenter();
      const v = connect();
      const id = randomUUID();
      send(p.peer, { t: "stroke.start", stroke: { id, h: 1, v: 0, step: 0, tool: "pen", color: "#000000", width: 4 } });
      rooms.leave(p.peer);
      expect(v.socket.of("item.remove")[0]?.id).toBe(id);
      expect(connect().socket.of("snapshot")[0]?.live).toEqual([]);
    });

    it("keeps a stroke finished on a new socket when the old socket closes late", () => {
      const old = presenter();
      const v = connect();
      const item = stroke();
      const { id, h, step } = item;
      send(old.peer, { t: "stroke.start", stroke: { id, h, v: 0, step, tool: "pen", color: "#000000", width: 4 } });
      const fresh = presenter();
      send(fresh.peer, { t: "stroke.end", m: "a", item });
      rooms.leave(old.peer);
      expect(v.socket.of("item.remove")).toEqual([]);
      expect(store.liveItems(SLUG)).toHaveLength(1);
    });

    it("counts viewers and presenters apart", () => {
      presenter();
      const v = connect();
      expect(rooms.counts(SLUG)).toEqual({ viewers: 1, presenters: 1 });
      rooms.leave(v.peer);
      expect(rooms.counts(SLUG)).toEqual({ viewers: 0, presenters: 1 });
    });

    it("tells everyone when the session is removed", () => {
      const v = connect();
      rooms.removed(SLUG);
      expect(v.socket.of("session.removed")).toHaveLength(1);
      expect(v.socket.closed).toBe(CLOSE.removed);
    });

    it("refuses a connection to a session that does not exist", () => {
      const socket = new FakeSocket();
      expect(rooms.join("missing", socket)).toBeUndefined();
      expect(socket.closed).toBe(CLOSE.noSession);
    });

    it("drops a socket that missed a heartbeat", () => {
      const { socket, peer } = connect();
      rooms.heartbeat();
      expect(socket.pings).toBe(1);
      peer.alive = true;
      rooms.heartbeat();
      expect(socket.terminated).toBe(false);
      rooms.heartbeat();
      expect(socket.terminated).toBe(true);
    });
  });

  describe("questions", () => {
    const voter = randomUUID();
    const ask = (peer: Peer, id = randomUUID(), by = voter, text = "Prečo?") => {
      send(peer, { t: "question.ask", m: randomUUID(), voter: by, question: { id, text, slide: { h: 3, v: 1 } } });
      return id;
    };
    const vote = (peer: Peer, id: string, by: string, on = true) =>
      send(peer, { t: "question.vote", m: randomUUID(), id, voter: by, on });

    it("shows a question to everyone with the asker's vote, and to late joiners", () => {
      const a = connect();
      const b = connect();
      const p = presenter();
      const id = ask(a.peer);
      const expected = { id, text: "Prečo?", slide: { h: 3, v: 1 }, votes: 1, answered: false };
      for (const socket of [a.socket, b.socket, p.socket]) expect(socket.of("question.add")[0]?.question).toEqual(expected);
      expect(a.socket.of("ack")).toHaveLength(1);
      expect(connect().socket.of("snapshot")[0]?.questions).toEqual([expected]);
    });

    it("treats a resent question as the same one", () => {
      const a = connect();
      const id = ask(a.peer);
      ask(a.peer, id);
      expect(store.questions(SLUG)).toHaveLength(1);
      expect(a.socket.of("question.add")).toHaveLength(1);
      expect(a.socket.of("ack")).toHaveLength(2);
    });

    it("counts one vote per voter, and a vote can be taken back", () => {
      const a = connect();
      const id = ask(a.peer);
      const other = randomUUID();
      vote(a.peer, id, other);
      vote(a.peer, id, other);
      vote(a.peer, id, voter);
      expect(store.question(SLUG, id)?.votes).toBe(2);
      expect(a.socket.of("question.update")).toHaveLength(1);
      vote(a.peer, id, other, false);
      expect(a.socket.of("question.update").at(-1)?.question.votes).toBe(1);
    });

    it("keeps a removed question removed, even if it is resent", () => {
      const a = connect();
      const p = presenter();
      const id = ask(a.peer);
      send(p.peer, { t: "question.remove", m: "r", id });
      expect(a.socket.of("question.remove")[0]?.id).toBe(id);
      ask(a.peer, id);
      vote(a.peer, id, randomUUID());
      expect(store.questions(SLUG)).toEqual([]);
      expect(connect().socket.of("snapshot")[0]?.questions).toEqual([]);
    });

    it("marks a question answered and back", () => {
      const a = connect();
      const p = presenter();
      const id = ask(a.peer);
      send(p.peer, { t: "question.answer", m: "1", id, answered: true });
      send(p.peer, { t: "question.answer", m: "2", id, answered: true });
      expect(a.socket.of("question.update").map((m) => m.question.answered)).toEqual([true]);
      send(p.peer, { t: "question.answer", m: "3", id, answered: false });
      expect(store.question(SLUG, id)?.answered).toBe(false);
    });

    it("can't reach a question in another session", () => {
      const a = connect();
      const p = presenter("other");
      const id = ask(a.peer);
      send(p.peer, { t: "question.remove", m: "1", id });
      send(p.peer, { t: "question.answer", m: "2", id, answered: true });
      const o = connect("other");
      vote(o.peer, id, randomUUID());
      expect(store.question(SLUG, id)).toMatchObject({ votes: 1, answered: false });
    });

    it("limits asks per connection and lets them through again later", () => {
      const a = connect();
      for (let i = 0; i < 5; i++) ask(a.peer);
      const refused = ask(a.peer);
      expect(a.socket.of("question.rejected")[0]?.reason).toBe("rate");
      expect(store.question(SLUG, refused)).toBeUndefined();
      now += 60_001;
      ask(a.peer, refused);
      expect(store.questions(SLUG)).toHaveLength(6);
    });

    it("limits votes per connection", () => {
      const a = connect();
      const id = ask(a.peer);
      for (let i = 0; i < 61; i++) vote(a.peer, id, randomUUID());
      expect(store.question(SLUG, id)?.votes).toBe(61);
      expect(a.socket.of("question.rejected")).toHaveLength(1);
    });

    it("stops at the session cap, counting removed questions", () => {
      const a = connect();
      const p = presenter();
      for (let i = 0; i < 500; i++) {
        const id = randomUUID();
        store.addQuestion(SLUG, id, "x", 0, 0, voter);
        if (i === 0) send(p.peer, { t: "question.remove", m: "1", id });
      }
      ask(a.peer);
      expect(a.socket.of("question.rejected")[0]?.reason).toBe("full");
    });

    it.each([
      ["empty text", { text: "   " }],
      ["text over the limit", { text: "x".repeat(501) }],
      ["a bad id", { id: "nope" }],
      ["no slide", { slide: undefined }],
    ])("disconnects a viewer asking with %s", (_name, change) => {
      const { socket, peer } = connect();
      const question = { id: randomUUID(), text: "ok", slide: { h: 0, v: 0 }, ...change };
      send(peer, { t: "question.ask", m: "1", voter, question });
      expect(socket.closed).toBe(CLOSE.invalid);
      expect(store.questions(SLUG)).toEqual([]);
    });

    it("disconnects a malformed vote", () => {
      const { socket, peer } = connect();
      send(peer, { t: "question.vote", m: "1", id: randomUUID(), voter: "x", on: true });
      expect(socket.closed).toBe(CLOSE.invalid);
    });

    it("goes when the session goes", () => {
      const a = connect();
      const id = ask(a.peer);
      store.deleteSession(SLUG);
      expect(store.questionExists(id)).toBe(false);
    });
  });

  describe("join code", () => {
    it("reaches everyone else and late joiners, and is not lost on the presenter's reconnect", () => {
      const a = connect();
      const p = presenter();
      send(p.peer, { t: "join", m: "1", shown: true });
      expect(a.socket.of("join")[0]?.shown).toBe(true);
      expect(p.socket.of("join")).toEqual([]);
      expect(p.socket.of("ack").map((m) => m.m)).toEqual(["1"]);
      expect(connect().socket.of("snapshot")[0]?.join).toBe(true);
      rooms.leave(p.peer);
      expect(presenter().socket.of("snapshot").at(-1)?.join).toBe(true);
    });

    it("rejects a malformed message", () => {
      const p = presenter();
      send(p.peer, { t: "join", m: "1", shown: "yes" });
      expect(p.socket.closed).toBe(CLOSE.invalid);
    });
  });
});

describe("etagMatches", () => {
  it("accepts the validator with Caddy's suffix or a weak marker", () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"abc-zstd"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc-gzip"', '"abc"')).toBe(true);
    expect(etagMatches('"abd"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
  });
});
