CREATE TABLE IF NOT EXISTS knowledge_sources (
  id int(11) NOT NULL AUTO_INCREMENT,
  domain enum('legal', 'general', 'mixed') NOT NULL DEFAULT 'general',
  target enum('coop', 'group', 'all', 'general') NOT NULL DEFAULT 'general',
  title varchar(255) NOT NULL,
  source_text longtext NOT NULL,
  normalized_text longtext DEFAULT NULL,
  source_reference text DEFAULT NULL,
  document_type varchar(100) DEFAULT NULL,
  status enum('draft', 'approved', 'archived') NOT NULL DEFAULT 'draft',
  created_by varchar(255) DEFAULT NULL,
  approved_by varchar(255) DEFAULT NULL,
  approved_at timestamp NULL DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_knowledge_sources_domain_target_status (domain, target, status),
  KEY idx_knowledge_sources_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE IF NOT EXISTS knowledge_drafts (
  id int(11) NOT NULL AUTO_INCREMENT,
  source_id int(11) NOT NULL,
  question varchar(500) NOT NULL,
  short_answer text NOT NULL,
  detailed_answer longtext DEFAULT NULL,
  keywords_json text DEFAULT NULL,
  confidence enum('high', 'medium', 'low') NOT NULL DEFAULT 'medium',
  notes text DEFAULT NULL,
  status enum('draft', 'approved', 'rejected') NOT NULL DEFAULT 'draft',
  approved_target enum('coop', 'group', 'all', 'general') DEFAULT NULL,
  approved_record_id int(11) DEFAULT NULL,
  created_at timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_knowledge_drafts_source_id (source_id),
  KEY idx_knowledge_drafts_status (status),
  CONSTRAINT fk_knowledge_drafts_source
    FOREIGN KEY (source_id) REFERENCES knowledge_sources(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
