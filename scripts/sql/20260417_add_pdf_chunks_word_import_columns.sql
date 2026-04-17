SET @db_name := DATABASE();

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'clean_text'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN clean_text TEXT NULL AFTER chunk_text'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'chunk_type'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN chunk_type VARCHAR(20) NULL AFTER document_id'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'title'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN title VARCHAR(255) NULL AFTER chunk_type'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'question'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN question TEXT NULL AFTER title'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'answer'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN answer LONGTEXT NULL AFTER question'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'note_value'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN note_value TEXT NULL AFTER answer'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'step_no'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN step_no INT(11) NULL AFTER note_value'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'detail'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN detail LONGTEXT NULL AFTER step_no'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'reference_note'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN reference_note TEXT NULL AFTER detail'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'source_file_name'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN source_file_name VARCHAR(255) NULL AFTER reference_note'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'source_file_hash'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN source_file_hash CHAR(64) NULL AFTER source_file_name'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'import_batch_id'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN import_batch_id CHAR(36) NULL AFTER source_file_hash'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND COLUMN_NAME = 'sort_order'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD COLUMN sort_order INT(11) NOT NULL DEFAULT 0 AFTER import_batch_id'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND INDEX_NAME = 'idx_pdf_chunks_chunk_type'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD KEY idx_pdf_chunks_chunk_type (chunk_type)'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND INDEX_NAME = 'idx_pdf_chunks_source_file_hash'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD KEY idx_pdf_chunks_source_file_hash (source_file_hash)'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND INDEX_NAME = 'idx_pdf_chunks_import_batch_id'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD KEY idx_pdf_chunks_import_batch_id (import_batch_id)'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND INDEX_NAME = 'idx_pdf_chunks_sort_order'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD KEY idx_pdf_chunks_sort_order (sort_order)'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;

SET @stmt := (
  SELECT IF(
    EXISTS(
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = @db_name
        AND TABLE_NAME = 'pdf_chunks'
        AND INDEX_NAME = 'idx_pdf_chunks_hybrid_search'
    ),
    'SELECT 1',
    'ALTER TABLE pdf_chunks ADD FULLTEXT KEY idx_pdf_chunks_hybrid_search (keyword, title, question, answer, chunk_text, clean_text)'
  )
);
PREPARE sql_stmt FROM @stmt;
EXECUTE sql_stmt;
DEALLOCATE PREPARE sql_stmt;
