import type Database from "better-sqlite3";
import type { Item, ItemData, Position } from "../shared/protocol.ts";

export interface Deck {
  id: string;
  title: string;
  filename: string;
  hash: string;
  size: number;
  uploadedAt: number;
}

export interface Session {
  slug: string;
  deckId: string;
  title: string;
  createdAt: number;
  position: Position;
}

interface SessionRow {
  slug: string;
  deck_id: string;
  title: string;
  created_at: number;
  h: number;
  v: number;
  f: number;
}

interface DeckRow {
  id: string;
  title: string;
  filename: string;
  hash: string;
  size: number;
  uploaded_at: number;
}

interface ItemRow {
  id: string;
  kind: Item["kind"];
  h: number;
  v: number;
  step: number;
  data: string;
}

const toDeck = (r: DeckRow): Deck => ({
  id: r.id,
  title: r.title,
  filename: r.filename,
  hash: r.hash,
  size: r.size,
  uploadedAt: r.uploaded_at,
});

const toSession = (r: SessionRow): Session => ({
  slug: r.slug,
  deckId: r.deck_id,
  title: r.title,
  createdAt: r.created_at,
  position: { h: r.h, v: r.v, f: r.f },
});

const toItem = (r: ItemRow): Item =>
  ({ id: r.id, kind: r.kind, h: r.h, v: r.v, step: r.step, data: JSON.parse(r.data) as ItemData }) as Item;

export class Store {
  constructor(private readonly db: Database.Database) {}

  // Decks

  deck(id: string): Deck | undefined {
    const row = this.db.prepare("SELECT * FROM decks WHERE id = ?").get(id) as DeckRow | undefined;
    return row && toDeck(row);
  }

  deckByHash(hash: string): Deck | undefined {
    const row = this.db.prepare("SELECT * FROM decks WHERE hash = ?").get(hash) as DeckRow | undefined;
    return row && toDeck(row);
  }

  decks(): Deck[] {
    const rows = this.db.prepare("SELECT * FROM decks ORDER BY uploaded_at DESC").all() as DeckRow[];
    return rows.map(toDeck);
  }

  insertDeck(deck: Deck): void {
    this.db
      .prepare("INSERT INTO decks (id, title, filename, hash, size, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(deck.id, deck.title, deck.filename, deck.hash, deck.size, deck.uploadedAt);
  }

  deleteDeck(id: string): void {
    this.db.prepare("DELETE FROM decks WHERE id = ?").run(id);
  }

  sessionCountForDeck(id: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE deck_id = ?").get(id) as { n: number };
    return row.n;
  }

  // Sessions

  session(slug: string): Session | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE slug = ?").get(slug) as SessionRow | undefined;
    return row && toSession(row);
  }

  sessions(): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY created_at DESC").all() as SessionRow[];
    return rows.map(toSession);
  }

  insertSession(slug: string, deckId: string, title: string): void {
    this.db
      .prepare("INSERT INTO sessions (slug, deck_id, title, created_at) VALUES (?, ?, ?, ?)")
      .run(slug, deckId, title, Date.now());
  }

  /** Removes the session and, by cascade, its ink. */
  deleteSession(slug: string): void {
    this.db.prepare("DELETE FROM sessions WHERE slug = ?").run(slug);
  }

  setPosition(slug: string, p: Position): void {
    this.db.prepare("UPDATE sessions SET h = ?, v = ?, f = ? WHERE slug = ?").run(p.h, p.v, p.f, slug);
  }

  // Items

  liveItems(slug: string): Item[] {
    const rows = this.db
      .prepare("SELECT id, kind, h, v, step, data FROM items WHERE session_slug = ? AND deleted_at IS NULL ORDER BY rowid")
      .all(slug) as ItemRow[];
    return rows.map(toItem);
  }

  itemCount(slug: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM items WHERE session_slug = ? AND deleted_at IS NULL")
      .get(slug) as { n: number };
    return row.n;
  }

  /** Returns true when the id is new. A known id, even a deleted one, stays as it is. */
  addItem(slug: string, item: Item): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO items (id, session_slug, kind, h, v, step, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .run(item.id, slug, item.kind, item.h, item.v, item.step, JSON.stringify(item.data), Date.now());
    return result.changes > 0;
  }

  /** Returns true when the item went from live to deleted. */
  removeItem(slug: string, id: string): boolean {
    const result = this.db
      .prepare("UPDATE items SET deleted_at = ? WHERE id = ? AND session_slug = ? AND deleted_at IS NULL")
      .run(Date.now(), id, slug);
    return result.changes > 0;
  }

  /** Returns the item when it went from deleted to live. */
  restoreItem(slug: string, id: string): Item | undefined {
    const result = this.db
      .prepare("UPDATE items SET deleted_at = NULL WHERE id = ? AND session_slug = ? AND deleted_at IS NOT NULL")
      .run(id, slug);
    if (result.changes === 0) return undefined;
    const row = this.db.prepare("SELECT id, kind, h, v, step, data FROM items WHERE id = ?").get(id) as ItemRow;
    return toItem(row);
  }

  /** Deletes the named items on a slide and returns the ids that really changed. */
  clearItems(slug: string, h: number, v: number, ids: readonly string[]): string[] {
    const update = this.db.prepare(
      "UPDATE items SET deleted_at = ? WHERE id = ? AND session_slug = ? AND h = ? AND v = ? AND deleted_at IS NULL",
    );
    const now = Date.now();
    return this.db.transaction(() => ids.filter((id) => update.run(now, id, slug, h, v).changes > 0))();
  }
}
