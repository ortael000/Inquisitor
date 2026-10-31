CREATE TABLE collection_coverage (
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  day_utc TEXT NOT NULL,
  scope_key TEXT NOT NULL CHECK (length(trim(scope_key)) > 0),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (source, day_utc, scope_key)
);
