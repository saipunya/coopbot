const { getDbPool } = require("../config/db");

function parseMetadataJson(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(String(value));
  } catch (_) {
    return null;
  }
}

class LawChatbotAnswerCacheModel {
  static async findByQuestionHash(questionHash) {
    const pool = getDbPool();
    if (!pool) {
      return null;
    }

    const normalizedHash = String(questionHash || "").trim();
    if (!normalizedHash) {
      return null;
    }

    const [rows] = await pool.query(
      `SELECT id, question_hash, normalized_question, original_question, target,
              answer_text, metadata_json, hit_count, created_at, updated_at
       FROM law_chatbot_answer_cache
       WHERE question_hash = ?
       LIMIT 1`,
      [normalizedHash],
    );

    if (!rows[0]) {
      return null;
    }

    return {
      ...rows[0],
      metadata: parseMetadataJson(rows[0].metadata_json),
    };
  }

  static async incrementHitCount(id) {
    const pool = getDbPool();
    if (!pool) {
      return false;
    }

    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return false;
    }

    const [result] = await pool.query(
      `UPDATE law_chatbot_answer_cache
       SET hit_count = hit_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [normalizedId],
    );

    return result.affectedRows > 0;
  }

  static async upsert(payload = {}) {
    const pool = getDbPool();
    if (!pool) {
      return null;
    }

    const questionHash = String(payload.questionHash || "").trim();
    const normalizedQuestion = String(payload.normalizedQuestion || "").trim();
    const originalQuestion = String(payload.originalQuestion || "").trim();
    const target = String(payload.target || "all").trim() || "all";
    const answerText = String(payload.answerText || "").trim();
    const metadataJson =
      payload.metadata && typeof payload.metadata === "object"
        ? JSON.stringify(payload.metadata)
        : null;

    if (!questionHash || !normalizedQuestion || !originalQuestion || !answerText) {
      return null;
    }

    await pool.query(
      `INSERT INTO law_chatbot_answer_cache (
         question_hash,
         normalized_question,
         original_question,
         target,
         answer_text,
         metadata_json,
         hit_count
       )
       VALUES (?, ?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         normalized_question = VALUES(normalized_question),
         original_question = VALUES(original_question),
         target = VALUES(target),
         answer_text = VALUES(answer_text),
         metadata_json = VALUES(metadata_json),
         updated_at = CURRENT_TIMESTAMP`,
      [
        questionHash,
        normalizedQuestion,
        originalQuestion,
        target,
        answerText,
        metadataJson,
      ],
    );

    return this.findByQuestionHash(questionHash);
  }
}

module.exports = LawChatbotAnswerCacheModel;
