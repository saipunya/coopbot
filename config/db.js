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
    CREATE TABLE IF NOT EXISTS pdf_chunks (
      id int(11) NOT NULL AUTO_INCREMENT,
      keyword varchar(255) NOT NULL,
      chunk_text text NOT NULL,
      created_at timestamp NULL DEFAULT current_timestamp(),
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb3 COLLATE=utf8mb3_general_ci
  `);
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
