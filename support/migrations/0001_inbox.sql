CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  submitted_at INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('report', 'support')),
  email TEXT,
  reason TEXT,
  platform TEXT,
  app_version TEXT,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL
);
CREATE INDEX inbox_submitted_at ON inbox (submitted_at);
