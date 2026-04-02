ALTER TABLE documents
  ADD COLUMN extraction_method varchar(50) DEFAULT NULL AFTER file_size,
  ADD COLUMN extraction_quality_score int(11) DEFAULT NULL AFTER extraction_method,
  ADD COLUMN extraction_notes text DEFAULT NULL AFTER extraction_quality_score;
