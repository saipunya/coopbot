const { getDbPool } = require("../config/db");

const memorySuggestions = [];

function normalizeEntry(entry = {}) {
  return {
    target: entry.target === "group" ? "group" : "coop",
    title: String(entry.title || "").trim().slice(0, 255),
    content: String(entry.content || "").trim(),
    sourceType: String(entry.sourceType || "text").trim().slice(0, 30) || "text",
    submittedBy: String(entry.submittedBy || "").trim().slice(0, 255),
    submitterSession: String(entry.submitterSession || "").trim().slice(0, 255),
    submitterIp: String(entry.submitterIp || "").trim().slice(0, 80),
    status: ["pending", "approved", "rejected"].includes(entry.status) ? entry.status : "pending",
    reviewedBy: String(entry.reviewedBy || "").trim().slice(0, 255),
    reviewNote: String(entry.reviewNote || "").trim().slice(0, 255),
  };
}

function mapRow(row) {
  return {
    id: row.id,
    target: row.target === "group" ? "group" : "coop",
    title: row.title || "",
    content: row.content || "",
    sourceType: row.source_type || row.sourceType || "text",
    submittedBy: row.submitted_by || row.submittedBy || "",
    submitterSession: row.submitter_session || row.submitterSession || "",
    submitterIp: row.submitter_ip || row.submitterIp || "",
    status: row.status || "pending",
    reviewedBy: row.reviewed_by || row.reviewedBy || "",
    reviewNote: row.review_note || row.reviewNote || "",
    createdAt: row.created_at || row.createdAt || "",
    reviewedAt: row.reviewed_at || row.reviewedAt || "",
  };
}

let tableReadyPromise = null;

async function ensureTable() {
  const pool = getDbPool();
  if (!pool) {
    return;
  }

  if (!tableReadyPromise) {
    tableReadyPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS chatbot_knowledge_suggestions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        target ENUM('coop', 'group') NOT NULL DEFAULT 'coop',
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        source_type VARCHAR(30) NOT NULL DEFAULT 'text',
        submitted_by VARCHAR(255) NULL,
        submitter_session VARCHAR(255) NULL,
        submitter_ip VARCHAR(80) NULL,
        status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
        reviewed_by VARCHAR(255) NULL,
        review_note VARCHAR(255) NULL,
        reviewed_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_chatbot_knowledge_suggestions_status_created (status, created_at),
        INDEX idx_chatbot_knowledge_suggestions_target_status (target, status)
      )
    `);
  }

  await tableReadyPromise;
}

class LawChatbotKnowledgeSuggestionModel {
  static async create(entry) {
    const normalized = normalizeEntry(entry);
    const pool = getDbPool();

    if (!pool) {
      const record = {
        id: memorySuggestions.length + 1,
        createdAt: new Date().toISOString(),
        ...normalized,
      };
      memorySuggestions.unshift(record);
      return mapRow(record);
    }

    await ensureTable();
    const [result] = await pool.query(
      `INSERT INTO chatbot_knowledge_suggestions
        (target, title, content, source_type, submitted_by, submitter_session, submitter_ip, status, reviewed_by, review_note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.target,
        normalized.title,
        normalized.content,
        normalized.sourceType,
        normalized.submittedBy || null,
        normalized.submitterSession || null,
        normalized.submitterIp || null,
        normalized.status,
        normalized.reviewedBy || null,
        normalized.reviewNote || null,
      ],
    );

    return {
      id: result.insertId,
      ...normalized,
      createdAt: new Date().toISOString(),
    };
  }

  static async countPending() {
    const pool = getDbPool();
    if (!pool) {
      return memorySuggestions.filter((item) => item.status === "pending").length;
    }

    await ensureTable();
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS total FROM chatbot_knowledge_suggestions WHERE status = 'pending'",
    );
    return rows[0]?.total || 0;
  }

  static async listPending(limit = 20) {
    const pool = getDbPool();
    if (!pool) {
      return memorySuggestions
        .filter((item) => item.status === "pending")
        .slice(0, limit)
        .map(mapRow);
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT id, target, title, content, source_type, submitted_by, submitter_session,
              submitter_ip, status, reviewed_by, review_note, reviewed_at, created_at
         FROM chatbot_knowledge_suggestions
        WHERE status = 'pending'
        ORDER BY id DESC
        LIMIT ?`,
      [Number(limit || 20)],
    );

    return rows.map(mapRow);
  }

  static async findById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      const found = memorySuggestions.find((item) => Number(item.id) === normalizedId);
      return found ? mapRow(found) : null;
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT id, target, title, content, source_type, submitted_by, submitter_session,
              submitter_ip, status, reviewed_by, review_note, reviewed_at, created_at
         FROM chatbot_knowledge_suggestions
        WHERE id = ?
        LIMIT 1`,
      [normalizedId],
    );

    return rows[0] ? mapRow(rows[0]) : null;
  }

  static async updateStatus(id, status, reviewMeta = {}) {
    const normalizedId = Number(id || 0);
    if (!normalizedId || !["approved", "rejected"].includes(status)) {
      return false;
    }

    const normalizedMeta = normalizeEntry({
      status,
      reviewedBy: reviewMeta.reviewedBy || "",
      reviewNote: reviewMeta.reviewNote || "",
    });

    const pool = getDbPool();
    if (!pool) {
      const found = memorySuggestions.find((item) => Number(item.id) === normalizedId);
      if (!found) {
        return false;
      }

      found.status = status;
      found.reviewedBy = normalizedMeta.reviewedBy;
      found.reviewNote = normalizedMeta.reviewNote;
      found.reviewedAt = new Date().toISOString();
      return true;
    }

    await ensureTable();
    const [result] = await pool.query(
      `UPDATE chatbot_knowledge_suggestions
          SET status = ?, reviewed_by = ?, review_note = ?, reviewed_at = NOW()
        WHERE id = ? AND status = 'pending'
        LIMIT 1`,
      [
        status,
        normalizedMeta.reviewedBy || null,
        normalizedMeta.reviewNote || null,
        normalizedId,
      ],
    );

    return Number(result.affectedRows || 0) > 0;
  }
}

module.exports = LawChatbotKnowledgeSuggestionModel;
