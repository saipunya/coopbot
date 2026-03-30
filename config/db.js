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

  try {
    await pool.query("ALTER TABLE pdf_chunks ADD COLUMN document_id int(11) DEFAULT NULL");
  } catch (_) {}

  try {
    await pool.query("ALTER TABLE pdf_chunks ADD KEY idx_pdf_chunks_document_id (document_id)");
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
