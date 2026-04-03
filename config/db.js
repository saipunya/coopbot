const mysql = require("mysql2/promise");

let pool = null;

function hasDbConfig() {
  return Boolean(
    process.env.DATABASE_URL ||
      (process.env.DB_HOST &&
        process.env.DB_PORT &&
        process.env.DB_USER &&
        process.env.DB_NAME)
  );
}

function getPoolConfig() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME,
    charset: "utf8mb4",
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    queueLimit: 0,
  };
}

async function ensureSchema() {
  if (!pool) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id int(11) NOT NULL AUTO_INCREMENT,
      google_id varchar(255) NOT NULL,
      email varchar(255) NOT NULL,
      name varchar(255) DEFAULT NULL,
      avatar_url varchar(500) DEFAULT NULL,
      plan varchar(50) NOT NULL DEFAULT 'free',
      plan_started_at timestamp NULL DEFAULT current_timestamp(),
      plan_expires_at timestamp NULL DEFAULT NULL,
      premium_expires_at timestamp NULL DEFAULT NULL,
      status varchar(50) NOT NULL DEFAULT 'active',
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (id),
      UNIQUE KEY uniq_users_google_id (google_id),
      UNIQUE KEY uniq_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_monthly_usage (
      id int(11) NOT NULL AUTO_INCREMENT,
      user_id int(11) NOT NULL,
      usage_month char(7) NOT NULL,
      question_count int(11) NOT NULL DEFAULT 0,
      ai_preview_count int(11) NOT NULL DEFAULT 0,
      last_used_at timestamp NULL DEFAULT current_timestamp(),
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_monthly_usage_user_month (user_id, usage_month),
      KEY idx_user_monthly_usage_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_requests (
      id int(11) NOT NULL AUTO_INCREMENT,
      user_id int(11) NOT NULL,
      plan_name varchar(100) NOT NULL,
      amount decimal(10,2) NOT NULL,
      slip_image varchar(500) DEFAULT NULL,
      note text DEFAULT NULL,
      status varchar(50) NOT NULL DEFAULT 'pending',
      reviewed_at timestamp NULL DEFAULT NULL,
      reviewed_by varchar(255) DEFAULT NULL,
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (id),
      KEY idx_payment_requests_user_id (user_id),
      KEY idx_payment_requests_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_search_history (
      id int(11) NOT NULL AUTO_INCREMENT,
      user_id int(11) NOT NULL,
      plan_code varchar(50) NOT NULL DEFAULT 'free',
      target varchar(20) NOT NULL DEFAULT 'all',
      question_text text NOT NULL,
      answer_preview text DEFAULT NULL,
      created_at timestamp NULL DEFAULT current_timestamp(),
      expires_at timestamp NULL DEFAULT NULL,
      PRIMARY KEY (id),
      KEY idx_user_search_history_user_id_created_at (user_id, created_at),
      KEY idx_user_search_history_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
    `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid varchar(255) NOT NULL,
      sess longtext NOT NULL,
      expires_at bigint(20) NOT NULL,
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (sid),
      KEY idx_sessions_expires_at (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci

    `);

  await pool.query(`

    CREATE TABLE IF NOT EXISTS runtime_settings (
      setting_key varchar(100) NOT NULL,
      setting_value text NOT NULL,
      updated_by varchar(255) DEFAULT NULL,
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (setting_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  
    `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS law_chatbot_answer_cache (
      id int(11) NOT NULL AUTO_INCREMENT,
      question_hash char(64) NOT NULL,
      normalized_question text NOT NULL,
      original_question text NOT NULL,
      target varchar(20) NOT NULL DEFAULT 'all',
      answer_text longtext NOT NULL,
      metadata_json longtext DEFAULT NULL,
      hit_count int(11) NOT NULL DEFAULT 0,
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (id),
      UNIQUE KEY uniq_law_chatbot_answer_cache_question_hash (question_hash),
      KEY idx_law_chatbot_answer_cache_target (target)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS documents (
      id int(11) NOT NULL AUTO_INCREMENT,
      title varchar(255) DEFAULT NULL,
      document_number varchar(100) DEFAULT NULL,
      document_date date DEFAULT NULL,
      document_date_text varchar(100) DEFAULT NULL,
      document_source varchar(255) DEFAULT NULL,
      filename varchar(255) DEFAULT NULL,
      originalname varchar(255) DEFAULT NULL,
      mimetype varchar(150) DEFAULT NULL,
      file_size bigint DEFAULT NULL,
      extraction_method varchar(50) DEFAULT NULL,
      extraction_quality_score int(11) DEFAULT NULL,
      extraction_notes text DEFAULT NULL,
      is_searchable tinyint(1) NOT NULL DEFAULT 1,
      quality_status varchar(20) NOT NULL DEFAULT 'accepted',
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS pdf_chunks (
      id int(11) NOT NULL AUTO_INCREMENT,
      keyword varchar(255) NOT NULL,
      chunk_text text NOT NULL,
      document_id int(11) DEFAULT NULL,
      created_at timestamp NULL DEFAULT current_timestamp(),
      PRIMARY KEY (id),
      KEY idx_pdf_chunks_document_id (document_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chatbot_knowledge (
      id int(11) NOT NULL AUTO_INCREMENT,
      target enum('coop','group') NOT NULL DEFAULT 'coop',
      title varchar(255) NOT NULL,
      law_number varchar(100) DEFAULT NULL,
      content text NOT NULL,
      source_note varchar(255) DEFAULT NULL,
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (id),
      KEY idx_chatbot_knowledge_target (target)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
 
 
    `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS chatbot_suggested_questions (
      id int(11) NOT NULL AUTO_INCREMENT,
      target enum('all','coop','group') NOT NULL DEFAULT 'all',
      question_text varchar(255) NOT NULL,
      normalized_question varchar(255) NOT NULL,
      answer_text text NOT NULL,
      display_order int(11) NOT NULL DEFAULT 0,
      is_active tinyint(1) NOT NULL DEFAULT 1,
      created_at timestamp NULL DEFAULT current_timestamp(),
      updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
      PRIMARY KEY (id),
      KEY idx_chatbot_suggested_questions_active_order (is_active, display_order, id),
      KEY idx_chatbot_suggested_questions_target_active (target, is_active),
      KEY idx_chatbot_suggested_questions_normalized (normalized_question)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci

    `);

  try {
    await pool.query("ALTER TABLE law_chatbot_answer_cache ADD COLUMN metadata_json longtext DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE law_chatbot_answer_cache ADD COLUMN hit_count int(11) NOT NULL DEFAULT 0");
  } catch (_) {}

  try {
    await pool.query('ALTER TABLE law_chatbot_answer_cache ADD COLUMN created_at timestamp NULL DEFAULT current_timestamp()');
  } catch (_) {}

  try {
    await pool.query('ALTER TABLE law_chatbot_answer_cache ADD COLUMN updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()');
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE law_chatbot_answer_cache ADD UNIQUE KEY uniq_law_chatbot_answer_cache_question_hash (question_hash)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE law_chatbot_answer_cache ADD KEY idx_law_chatbot_answer_cache_target (target)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE documents ADD COLUMN extraction_method varchar(50) DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE documents ADD COLUMN extraction_quality_score int(11) DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE documents ADD COLUMN extraction_notes text DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE documents ADD COLUMN is_searchable tinyint(1) NOT NULL DEFAULT 1");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE documents ADD COLUMN quality_status varchar(20) NOT NULL DEFAULT 'accepted'");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE pdf_chunks ADD COLUMN document_id int(11) DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE pdf_chunks ADD KEY idx_pdf_chunks_document_id (document_id)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_knowledge ADD COLUMN source_note varchar(255) DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD COLUMN target enum('all','coop','group') NOT NULL DEFAULT 'all'");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD COLUMN question_text varchar(255) NOT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD COLUMN normalized_question varchar(255) NOT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD COLUMN answer_text text NOT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD COLUMN display_order int(11) NOT NULL DEFAULT 0");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD COLUMN is_active tinyint(1) NOT NULL DEFAULT 1");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD COLUMN created_at timestamp NULL DEFAULT current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD COLUMN updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD KEY idx_chatbot_suggested_questions_active_order (is_active, display_order, id)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD KEY idx_chatbot_suggested_questions_target_active (target, is_active)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_suggested_questions ADD KEY idx_chatbot_suggested_questions_normalized (normalized_question)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE chatbot_knowledge ADD KEY idx_chatbot_knowledge_target (target)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD COLUMN avatar_url varchar(500) DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD COLUMN plan varchar(50) NOT NULL DEFAULT 'free'");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD COLUMN plan_started_at timestamp NULL DEFAULT current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD COLUMN plan_expires_at timestamp NULL DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD COLUMN premium_expires_at timestamp NULL DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD COLUMN status varchar(50) NOT NULL DEFAULT 'active'");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD COLUMN created_at timestamp NULL DEFAULT current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD COLUMN updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD UNIQUE KEY uniq_users_google_id (google_id)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE users ADD UNIQUE KEY uniq_users_email (email)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_monthly_usage ADD COLUMN ai_preview_count int(11) NOT NULL DEFAULT 0");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_monthly_usage ADD COLUMN last_used_at timestamp NULL DEFAULT current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_monthly_usage ADD COLUMN created_at timestamp NULL DEFAULT current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_monthly_usage ADD COLUMN updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_monthly_usage CHANGE COLUMN `year_month` usage_month char(7) NOT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_monthly_usage ADD COLUMN usage_month char(7) NOT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_monthly_usage ADD UNIQUE KEY uniq_user_monthly_usage_user_month (user_id, usage_month)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_monthly_usage ADD KEY idx_user_monthly_usage_user_id (user_id)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD COLUMN slip_image varchar(500) DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD COLUMN note text DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD COLUMN status varchar(50) NOT NULL DEFAULT 'pending'");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD COLUMN reviewed_at timestamp NULL DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD COLUMN reviewed_by varchar(255) DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD COLUMN created_at timestamp NULL DEFAULT current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD COLUMN updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD KEY idx_payment_requests_user_id (user_id)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE payment_requests ADD KEY idx_payment_requests_status (status)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_search_history ADD COLUMN plan_code varchar(50) NOT NULL DEFAULT 'free'");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_search_history ADD COLUMN target varchar(20) NOT NULL DEFAULT 'all'");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_search_history ADD COLUMN question_text text NOT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_search_history ADD COLUMN answer_preview text DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_search_history ADD COLUMN created_at timestamp NULL DEFAULT current_timestamp()");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_search_history ADD COLUMN expires_at timestamp NULL DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_search_history ADD KEY idx_user_search_history_user_id_created_at (user_id, created_at)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE user_search_history ADD KEY idx_user_search_history_expires_at (expires_at)");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE tbl_glaws ADD COLUMN glaw_search text DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query(`
      UPDATE users
      SET plan_started_at = COALESCE(plan_started_at, created_at, CURRENT_TIMESTAMP),
          plan_expires_at = CASE
            WHEN plan_expires_at IS NOT NULL THEN plan_expires_at
            WHEN premium_expires_at IS NOT NULL THEN premium_expires_at
            ELSE NULL
          END
      WHERE plan_started_at IS NULL
         OR (plan_expires_at IS NULL AND premium_expires_at IS NOT NULL)
    `);
  } catch (_) {}

  try {
    await pool.query(`
      UPDATE user_monthly_usage
      SET created_at = COALESCE(created_at, last_used_at, CURRENT_TIMESTAMP),
          updated_at = COALESCE(updated_at, last_used_at, CURRENT_TIMESTAMP)
      WHERE created_at IS NULL OR updated_at IS NULL
    `);
  } catch (_) {}

  try {
    await pool.query(`
      DELETE FROM user_search_history
      WHERE expires_at IS NOT NULL
        AND expires_at <= CURRENT_TIMESTAMP
    `);
  } catch (_) {}
}

async function connectDb() {
  if (!hasDbConfig()) {
    console.log("Database status: stub mode");
    return null;
  }

  if (pool) {
    return pool;
  }

  try {
    pool = mysql.createPool(getPoolConfig());
    await pool.query("SELECT 1");
    await ensureSchema();
    console.log("Database status: connected");
    return pool;
  } catch (error) {
    pool = null;
    console.error(`Database status: unavailable (${error.code || error.message})`);
    return null;
  }
}

function getDbPool() {
  return pool;
}

module.exports = {
  connectDb,
  ensureSchema,
  getDbPool,
  hasDbConfig,
};
