import type Database from "better-sqlite3";
import type { Item, ItemData, Position, Question } from "../shared/protocol.ts";

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

interface QuestionRow {
  id: string;
  text: string;
  h: number;
  v: number;
  answered_at: number | null;
  votes: number;
}

const QUESTION_SELECT = `
  SELECT q.id, q.text, q.h, q.v, q.answered_at, COUNT(v.voter) AS votes
  FROM questions q LEFT JOIN question_votes v ON v.question_id = q.id
  WHERE q.session_slug = ? AND q.removed_at IS NULL`;

const toQuestion = (r: QuestionRow): Question => ({
  id: r.id,
  text: r.text,
  slide: { h: r.h, v: r.v },
  votes: r.votes,
  answered: r.answered_at !== null,
});

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

  /** Removes the session and, by cascade, its ink and questions. */
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

  // Questions

  questions(slug: string): Question[] {
    const rows = this.db.prepare(`${QUESTION_SELECT} GROUP BY q.id ORDER BY q.rowid`).all(slug) as QuestionRow[];
    return rows.map(toQuestion);
  }

  question(slug: string, id: string): Question | undefined {
    const row = this.db.prepare(`${QUESTION_SELECT} AND q.id = ? GROUP BY q.id`).get(slug, id) as QuestionRow | undefined;
    return row && toQuestion(row);
  }

  /** True for any id ever used, removed questions included. */
  questionExists(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM questions WHERE id = ?").get(id) !== undefined;
  }

  /** Counts removed questions too, so removing spam doesn't make room for more of it. */
  questionCount(slug: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM questions WHERE session_slug = ?").get(slug) as { n: number };
    return row.n;
  }

  /** Stores a new question, which starts with the asker's own vote. */
  addQuestion(slug: string, id: string, text: string, h: number, v: number, voter: string): Question {
    this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO questions (id, session_slug, text, h, v, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, slug, text, h, v, Date.now());
      this.db.prepare("INSERT INTO question_votes (question_id, voter) VALUES (?, ?)").run(id, voter);
    })();
    return this.question(slug, id)!;
  }

  /** Returns the question when the vote really changed. */
  setVote(slug: string, id: string, voter: string, on: boolean): Question | undefined {
    if (!this.question(slug, id)) return undefined;
    const result = on
      ? this.db
          .prepare("INSERT INTO question_votes (question_id, voter) VALUES (?, ?) ON CONFLICT DO NOTHING")
          .run(id, voter)
      : this.db.prepare("DELETE FROM question_votes WHERE question_id = ? AND voter = ?").run(id, voter);
    return result.changes > 0 ? this.question(slug, id) : undefined;
  }

  /** Returns the question when its state really changed. */
  setAnswered(slug: string, id: string, answered: boolean): Question | undefined {
    const result = this.db
      .prepare(
        `UPDATE questions SET answered_at = ? WHERE id = ? AND session_slug = ? AND removed_at IS NULL
         AND (answered_at IS NOT NULL) <> ?`,
      )
      .run(answered ? Date.now() : null, id, slug, answered ? 1 : 0);
    return result.changes > 0 ? this.question(slug, id) : undefined;
  }

  /** Returns true when the question went from visible to removed. */
  removeQuestion(slug: string, id: string): boolean {
    const result = this.db
      .prepare("UPDATE questions SET removed_at = ? WHERE id = ? AND session_slug = ? AND removed_at IS NULL")
      .run(Date.now(), id, slug);
    return result.changes > 0;
  }
}
