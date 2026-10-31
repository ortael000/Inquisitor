CREATE TABLE articles (
  article_id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  provider_article_id TEXT NOT NULL CHECK (length(trim(provider_article_id)) > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  author TEXT,
  original_publisher TEXT,
  url TEXT,
  published_date TEXT NOT NULL,
  published_at_utc TEXT,
  publication_precision TEXT NOT NULL
    CHECK (publication_precision IN ('day','hour','minute','second','millisecond')),
  publication_source_text TEXT,
  content TEXT NOT NULL CHECK (length(trim(content)) > 0),
  content_kind TEXT NOT NULL CHECK (content_kind IN ('full','summary')),
  language TEXT,
  content_fingerprint TEXT NOT NULL,
  text_fingerprint TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  UNIQUE (source, provider_article_id),
  CHECK ((publication_precision = 'day' AND published_at_utc IS NULL)
      OR (publication_precision <> 'day' AND published_at_utc IS NOT NULL))
);

CREATE INDEX articles_publication_day ON articles(published_date);
CREATE INDEX articles_publication_time ON articles(published_at_utc);
CREATE INDEX articles_exact_text ON articles(content_kind, text_fingerprint);
