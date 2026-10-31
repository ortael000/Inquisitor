ALTER TABLE articles ADD COLUMN source_metadata_json TEXT
  CHECK (source_metadata_json IS NULL OR json_valid(source_metadata_json));
