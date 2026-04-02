ALTER TABLE documents
  ADD COLUMN is_searchable tinyint(1) NOT NULL DEFAULT 1 AFTER extraction_notes,
  ADD COLUMN quality_status varchar(20) NOT NULL DEFAULT 'accepted' AFTER is_searchable;
