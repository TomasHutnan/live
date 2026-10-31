import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLIENT_TAG, deckTitle, hasRevealInitialize, insertBeforeBodyEnd, relativeReferences } from "./inject.ts";
import type { Deck, Store } from "./store.ts";

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export class UploadError extends Error {}

export interface UploadResult {
  deck: Deck;
  /** True when these exact bytes were uploaded before. */
  existing: boolean;
  warnings: string[];
}

/** Decks are immutable: identical bytes reuse the deck, changed bytes make a new one. */
export class DeckFiles {
  constructor(
    private readonly dir: string,
    private readonly store: Store,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  originalPath(deck: Deck): string {
    return join(this.dir, `${deck.id}.original.html`);
  }

  servedPath(deck: Deck): string {
    return join(this.dir, `${deck.id}.live.html`);
  }

  private writeAtomic(path: string, content: Buffer | string): void {
    const temp = `${path}.tmp`;
    writeFileSync(temp, content);
    renameSync(temp, path);
  }

  ingest(bytes: Buffer, filename: string): UploadResult {
    const html = bytes.toString("utf8");
    if (!hasRevealInitialize(html)) {
      throw new UploadError(
        "This file has no Reveal.initialize call, so it is not a reveal.js deck. Upload the HTML that Quarto built.",
      );
    }
    const relative = relativeReferences(html);
    const warnings = relative.length
      ? [
          `The deck references ${relative.length} relative file(s) that will not be served: ${relative.slice(0, 5).join(", ")}. ` +
            "Build it with embed-resources: true.",
        ]
      : [];

    const hash = createHash("sha256").update(bytes).digest("hex");
    const known = this.store.deckByHash(hash);
    if (known) return { deck: known, existing: true, warnings };

    const deck: Deck = {
      id: randomUUID(),
      title: deckTitle(html) ?? filename.replace(/\.html?$/i, ""),
      filename,
      hash,
      size: bytes.length,
      uploadedAt: Date.now(),
    };
    this.writeAtomic(this.originalPath(deck), bytes);
    this.writeAtomic(this.servedPath(deck), insertBeforeBodyEnd(html, CLIENT_TAG));
    this.store.insertDeck(deck);
    return { deck, existing: false, warnings };
  }

  remove(deck: Deck): void {
    this.store.deleteDeck(deck.id);
    rmSync(this.originalPath(deck), { force: true });
    rmSync(this.servedPath(deck), { force: true });
  }
}
