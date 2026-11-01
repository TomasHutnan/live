CREATE TABLE questions (
  id           TEXT PRIMARY KEY,
  session_slug TEXT NOT NULL REFERENCES sessions(slug) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  h            INTEGER NOT NULL,
  v            INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  answered_at  INTEGER,
  -- Kept rather than deleted, so a resent question can't bring a removed one back.
  removed_at   INTEGER
);

CREATE INDEX questions_session ON questions(session_slug, removed_at);

-- The voter is a random id the browser keeps for itself.
CREATE TABLE question_votes (
  question_id TEXT NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  voter       TEXT NOT NULL,
  PRIMARY KEY (question_id, voter)
) WITHOUT ROWID;
