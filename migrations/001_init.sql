CREATE TABLE decks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  filename    TEXT NOT NULL,
  hash        TEXT NOT NULL UNIQUE,
  size        INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  slug       TEXT PRIMARY KEY,
  deck_id    TEXT NOT NULL REFERENCES decks(id) ON DELETE RESTRICT,
  title      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  h          INTEGER NOT NULL DEFAULT 0,
  v          INTEGER NOT NULL DEFAULT 0,
  f          INTEGER NOT NULL DEFAULT -1
);

CREATE INDEX sessions_deck ON sessions(deck_id);

-- rowid order is the order items reached the server, which is the paint order.
CREATE TABLE items (
  id           TEXT PRIMARY KEY,
  session_slug TEXT NOT NULL REFERENCES sessions(slug) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('stroke', 'text')),
  h            INTEGER NOT NULL,
  v            INTEGER NOT NULL,
  step         INTEGER NOT NULL,
  data         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);

CREATE INDEX items_session ON items(session_slug, deleted_at);
