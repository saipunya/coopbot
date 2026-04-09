const { getDbPool } = require("../config/db");
const { normalizeForSearch } = require("../services/thaiTextUtils");

const memorySuggestedQuestions = [];
const SUGGESTED_QUESTION_SELECT_COLUMNS = `
  id,
  domain,
  target,
  question_text,
  normalized_question,
  answer_text,
  source_reference,
  source_id,
  draft_id,
  display_order,
  is_active,
  created_at,
  updated_at
`;

function normalizeQuestionText(value) {
  return normalizeForSearch(String(value || "")).toLowerCase();
}

function normalizeSuggestedQuestionDomain(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["legal", "general", "mixed"].includes(normalized) ? normalized : "general";
}

function normalizeSuggestedQuestionSourceId(value) {
  const normalized = Number(value || 0);
  return normalized > 0 ? normalized : null;
}

function normalizeSuggestedQuestionDraftId(value) {
  const normalized = Number(value || 0);
  return normalized > 0 ? normalized : null;
}

function normalizeEntry(entry = {}) {
  const rawDisplayOrder = Number(entry.displayOrder);

  return {
    domain: normalizeSuggestedQuestionDomain(entry.domain),
    target:
      entry.target === "coop" ? "coop" : entry.target === "group" ? "group" : "all",
    questionText: String(entry.questionText || entry.question || "").trim().slice(0, 255),
    answerText: String(entry.answerText || entry.answer || "").trim(),
    sourceReference: String(entry.sourceReference || entry.reference || "").trim(),
    sourceId: normalizeSuggestedQuestionSourceId(entry.sourceId || entry.source_id),
    draftId: normalizeSuggestedQuestionDraftId(entry.draftId || entry.draft_id),
    displayOrder: Number.isFinite(rawDisplayOrder) ? Math.max(0, Math.floor(rawDisplayOrder)) : 0,
    isActive:
      entry.isActive === false ||
      entry.isActive === "false" ||
      entry.isActive === "0" ||
      entry.isActive === 0
        ? 0
        : 1,
  };
}

function mapRow(row = {}) {
  return {
    id: row.id,
    domain: row.domain || "general",
    target: row.target === "coop" ? "coop" : row.target === "group" ? "group" : "all",
    questionText: row.question_text || row.questionText || "",
    normalizedQuestion: row.normalized_question || row.normalizedQuestion || "",
    answerText: row.answer_text || row.answerText || "",
    sourceReference: row.source_reference || row.sourceReference || "",
    sourceId: Number(row.source_id || row.sourceId || 0) || null,
    draftId: Number(row.draft_id || row.draftId || 0) || null,
    displayOrder: Number(row.display_order ?? row.displayOrder ?? 0) || 0,
    isActive:
      row.is_active === undefined
        ? true
        : row.is_active === true || row.is_active === 1 || row.is_active === "1",
    createdAt: row.created_at || row.createdAt || "",
    updatedAt: row.updated_at || row.updatedAt || "",
  };
}

let tableReadyPromise = null;

async function ensureTable() {
  const pool = getDbPool();
  if (!pool) {
    return;
  }

  if (!tableReadyPromise) {
    tableReadyPromise = pool
      .query(`
        CREATE TABLE IF NOT EXISTS chatbot_suggested_questions (
          id INT AUTO_INCREMENT PRIMARY KEY,
          domain ENUM('legal', 'general', 'mixed') NOT NULL DEFAULT 'general',
          target ENUM('all', 'coop', 'group') NOT NULL DEFAULT 'all',
          question_text VARCHAR(255) NOT NULL,
          normalized_question VARCHAR(255) NOT NULL,
          answer_text TEXT NOT NULL,
          source_reference TEXT DEFAULT NULL,
          source_id INT(11) DEFAULT NULL,
          draft_id INT(11) DEFAULT NULL,
          display_order INT NOT NULL DEFAULT 0,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_chatbot_suggested_questions_active_order (is_active, display_order, id),
          INDEX idx_chatbot_suggested_questions_target_active (target, is_active),
          INDEX idx_chatbot_suggested_questions_normalized (normalized_question),
          INDEX idx_chatbot_suggested_questions_domain (domain),
          INDEX idx_chatbot_suggested_questions_source_id (source_id),
          INDEX idx_chatbot_suggested_questions_draft_id (draft_id)
        )
      `)
      .then(async () => {
      const [domainColumns] = await pool.query(
        "SHOW COLUMNS FROM chatbot_suggested_questions LIKE 'domain'",
      );
      if (!Array.isArray(domainColumns) || domainColumns.length === 0) {
        await pool.query(
          "ALTER TABLE chatbot_suggested_questions ADD COLUMN domain enum('legal','general','mixed') NOT NULL DEFAULT 'general' AFTER id",
        );
      }

      const [sourceIdColumns] = await pool.query(
        "SHOW COLUMNS FROM chatbot_suggested_questions LIKE 'source_id'",
      );
      if (!Array.isArray(sourceIdColumns) || sourceIdColumns.length === 0) {
        await pool.query(
          "ALTER TABLE chatbot_suggested_questions ADD COLUMN source_id int(11) DEFAULT NULL AFTER source_reference",
        );
      }

      const [draftIdColumns] = await pool.query(
        "SHOW COLUMNS FROM chatbot_suggested_questions LIKE 'draft_id'",
      );
      if (!Array.isArray(draftIdColumns) || draftIdColumns.length === 0) {
        await pool.query(
          "ALTER TABLE chatbot_suggested_questions ADD COLUMN draft_id int(11) DEFAULT NULL AFTER source_id",
        );
      }

      const [domainIndexColumns] = await pool.query(
        "SHOW INDEX FROM chatbot_suggested_questions WHERE Key_name = 'idx_chatbot_suggested_questions_domain'",
      );
      if (!Array.isArray(domainIndexColumns) || domainIndexColumns.length === 0) {
        await pool.query(
          "ALTER TABLE chatbot_suggested_questions ADD KEY idx_chatbot_suggested_questions_domain (domain)",
        );
      }

      const [sourceIdIndexColumns] = await pool.query(
        "SHOW INDEX FROM chatbot_suggested_questions WHERE Key_name = 'idx_chatbot_suggested_questions_source_id'",
      );
      if (!Array.isArray(sourceIdIndexColumns) || sourceIdIndexColumns.length === 0) {
        await pool.query(
          "ALTER TABLE chatbot_suggested_questions ADD KEY idx_chatbot_suggested_questions_source_id (source_id)",
        );
      }

      const [draftIdIndexColumns] = await pool.query(
        "SHOW INDEX FROM chatbot_suggested_questions WHERE Key_name = 'idx_chatbot_suggested_questions_draft_id'",
      );
      if (!Array.isArray(draftIdIndexColumns) || draftIdIndexColumns.length === 0) {
        await pool.query(
          "ALTER TABLE chatbot_suggested_questions ADD KEY idx_chatbot_suggested_questions_draft_id (draft_id)",
        );
      }
    })
      .catch((error) => {
        tableReadyPromise = null;
        throw error;
      });
  }

  await tableReadyPromise;
}

class LawChatbotSuggestedQuestionModel {
  static async create(entry = {}) {
    const normalized = normalizeEntry(entry);
    if (!normalized.questionText || !normalized.answerText) {
      return null;
    }

    const normalizedQuestion = normalizeQuestionText(normalized.questionText);
    const pool = getDbPool();

    if (!pool) {
      const record = {
        id: memorySuggestedQuestions.length + 1,
        domain: normalized.domain,
        target: normalized.target,
        questionText: normalized.questionText,
        normalizedQuestion,
        answerText: normalized.answerText,
        sourceReference: normalized.sourceReference,
        sourceId: normalized.sourceId,
        draftId: normalized.draftId,
        displayOrder: normalized.displayOrder,
        isActive: normalized.isActive === 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      memorySuggestedQuestions.unshift(record);
      return mapRow(record);
    }

    await ensureTable();
    const [result] = await pool.query(
      `INSERT INTO chatbot_suggested_questions
        (domain, target, question_text, normalized_question, answer_text, source_reference, source_id, draft_id, display_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.domain,
        normalized.target,
        normalized.questionText,
        normalizedQuestion,
        normalized.answerText,
        normalized.sourceReference || null,
        normalized.sourceId,
        normalized.draftId,
        normalized.displayOrder,
        normalized.isActive,
      ],
    );

    return mapRow({
      id: result.insertId,
      domain: normalized.domain,
      target: normalized.target,
      question_text: normalized.questionText,
      normalized_question: normalizedQuestion,
      answer_text: normalized.answerText,
      source_reference: normalized.sourceReference,
      source_id: normalized.sourceId,
      draft_id: normalized.draftId,
      display_order: normalized.displayOrder,
      is_active: normalized.isActive,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  static async countAll() {
    const pool = getDbPool();
    if (!pool) {
      return memorySuggestedQuestions.length;
    }

    await ensureTable();
    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM chatbot_suggested_questions");
    return Number(rows[0]?.total || 0);
  }

  static async countActive() {
    const pool = getDbPool();
    if (!pool) {
      return memorySuggestedQuestions.filter((item) => item.isActive).length;
    }

    await ensureTable();
    const [rows] = await pool.query(
      "SELECT COUNT(*) AS total FROM chatbot_suggested_questions WHERE is_active = 1",
    );
    return Number(rows[0]?.total || 0);
  }

  static async findById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      const found = memorySuggestedQuestions.find((item) => Number(item.id) === normalizedId);
      return found ? mapRow(found) : null;
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
         FROM chatbot_suggested_questions
        WHERE id = ?
        LIMIT 1`,
      [normalizedId],
    );

    return rows[0] ? mapRow(rows[0]) : null;
  }

  static async listRecent(limit = 20, offset = 0) {
    const normalizedLimit = Math.max(1, Number(limit || 20));
    const normalizedOffset = Math.max(0, Number(offset || 0));
    const pool = getDbPool();

    if (!pool) {
      return memorySuggestedQuestions
        .slice()
        .sort((left, right) => {
          const activeDiff = Number(Boolean(right.isActive)) - Number(Boolean(left.isActive));
          if (activeDiff !== 0) {
            return activeDiff;
          }

          const orderDiff = Number(left.displayOrder || 0) - Number(right.displayOrder || 0);
          if (orderDiff !== 0) {
            return orderDiff;
          }

          return Number(right.id || 0) - Number(left.id || 0);
        })
        .slice(normalizedOffset, normalizedOffset + normalizedLimit)
        .map(mapRow);
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
         FROM chatbot_suggested_questions
        ORDER BY is_active DESC, display_order ASC, id DESC
        LIMIT ? OFFSET ?`,
      [normalizedLimit, normalizedOffset],
    );

    return rows.map(mapRow);
  }

  static async listActive(limit = 30, target = "all") {
    const normalizedLimit = Math.max(1, Number(limit || 30));
    const normalizedTarget =
      target === "coop" ? "coop" : target === "group" ? "group" : "all";
    const pool = getDbPool();

    if (!pool) {
      return memorySuggestedQuestions
        .filter((item) => {
          if (!item.isActive) {
            return false;
          }

          if (normalizedTarget === "all") {
            return true;
          }

          return item.target === "all" || item.target === normalizedTarget;
        })
        .sort((left, right) => {
          const orderDiff = Number(left.displayOrder || 0) - Number(right.displayOrder || 0);
          if (orderDiff !== 0) {
            return orderDiff;
          }
          return Number(right.id || 0) - Number(left.id || 0);
        })
        .slice(0, normalizedLimit)
        .map(mapRow);
    }

    await ensureTable();
    const [rows] =
      normalizedTarget === "all"
        ? await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
              ORDER BY display_order ASC, id DESC
              LIMIT ?`,
            [normalizedLimit],
          )
        : await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
                AND target IN ('all', ?)
              ORDER BY CASE WHEN target = ? THEN 0 ELSE 1 END, display_order ASC, id DESC
              LIMIT ?`,
            [normalizedTarget, normalizedTarget, normalizedLimit],
          );

    return rows.map(mapRow);
  }

  static async updateById(id, patch = {}) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return false;
    }

    const existing = await this.findById(normalizedId);
    if (!existing) {
      return false;
    }

    const normalized = normalizeEntry({
      domain: patch.domain !== undefined ? patch.domain : existing.domain,
      target: patch.target !== undefined ? patch.target : existing.target,
      questionText: patch.questionText !== undefined ? patch.questionText : existing.questionText,
      answerText: patch.answerText !== undefined ? patch.answerText : existing.answerText,
      sourceReference: patch.sourceReference !== undefined ? patch.sourceReference : existing.sourceReference,
      sourceId: patch.sourceId !== undefined ? patch.sourceId : existing.sourceId,
      draftId: patch.draftId !== undefined ? patch.draftId : existing.draftId,
      displayOrder: patch.displayOrder !== undefined ? patch.displayOrder : existing.displayOrder,
      isActive: patch.isActive !== undefined ? patch.isActive : existing.isActive,
    });

    if (!normalized.questionText || !normalized.answerText) {
      return false;
    }

    const normalizedQuestion = normalizeQuestionText(normalized.questionText);
    const pool = getDbPool();

    if (!pool) {
      const found = memorySuggestedQuestions.find((item) => Number(item.id) === normalizedId);
      if (!found) {
        return false;
      }

      Object.assign(found, {
        domain: normalized.domain,
        target: normalized.target,
        questionText: normalized.questionText,
        normalizedQuestion,
        answerText: normalized.answerText,
        sourceReference: normalized.sourceReference,
        sourceId: normalized.sourceId,
        draftId: normalized.draftId,
        displayOrder: normalized.displayOrder,
        isActive: normalized.isActive === 1,
        updatedAt: new Date().toISOString(),
      });
      return true;
    }

    await ensureTable();
    const [result] = await pool.query(
      `UPDATE chatbot_suggested_questions
          SET domain = ?,
              target = ?,
              question_text = ?,
              normalized_question = ?,
              answer_text = ?,
              source_reference = ?,
              source_id = ?,
              draft_id = ?,
              display_order = ?,
              is_active = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        LIMIT 1`,
      [
        normalized.domain,
        normalized.target,
        normalized.questionText,
        normalizedQuestion,
        normalized.answerText,
        normalized.sourceReference || null,
        normalized.sourceId,
        normalized.draftId,
        normalized.displayOrder,
        normalized.isActive,
        normalizedId,
      ],
    );

    return Number(result.affectedRows || 0) > 0;
  }

  static async removeById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return false;
    }

    const pool = getDbPool();
    if (!pool) {
      const index = memorySuggestedQuestions.findIndex((item) => Number(item.id) === normalizedId);
      if (index === -1) {
        return false;
      }

      memorySuggestedQuestions.splice(index, 1);
      return true;
    }

    await ensureTable();
    const [result] = await pool.query(
      "DELETE FROM chatbot_suggested_questions WHERE id = ? LIMIT 1",
      [normalizedId],
    );

    return Number(result.affectedRows || 0) > 0;
  }

  static async findAnswerMatch(question, target = "all") {
    const normalizedQuestion = normalizeQuestionText(question);
    if (!normalizedQuestion) {
      return null;
    }

    const normalizedTarget =
      target === "coop" ? "coop" : target === "group" ? "group" : "all";
    const pool = getDbPool();

    const sortMatches = (items) =>
      items.sort((left, right) => {
        const leftTarget = left.target === "coop" ? "coop" : left.target === "group" ? "group" : "all";
        const rightTarget = right.target === "coop" ? "coop" : right.target === "group" ? "group" : "all";

        const getPriority = (targetValue) => {
          if (normalizedTarget === "all") {
            return targetValue === "all" ? 0 : 1;
          }

          if (targetValue === normalizedTarget) {
            return 0;
          }

          if (targetValue === "all") {
            return 1;
          }

          return 2;
        };

        const priorityDiff = getPriority(leftTarget) - getPriority(rightTarget);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        const orderDiff = Number(left.displayOrder || 0) - Number(right.displayOrder || 0);
        if (orderDiff !== 0) {
          return orderDiff;
        }

        return Number(right.id || 0) - Number(left.id || 0);
      });

    if (!pool) {
      const found = sortMatches(
        memorySuggestedQuestions
          .filter((item) => {
            if (!item.isActive) {
              return false;
            }

            if (String(item.normalizedQuestion || "").trim() !== normalizedQuestion) {
              return false;
            }

            if (normalizedTarget === "all") {
              return true;
            }

            return item.target === "all" || item.target === normalizedTarget;
          })
          .map(mapRow),
      )[0];

      return found || null;
    }

    // Try exact match first
    const exactMatch = await this.findExactMatch(normalizedQuestion, normalizedTarget);
    if (exactMatch) {
      return exactMatch;
    }

    // Try fuzzy matching if no exact match
    return await this.findFuzzyMatch(normalizedQuestion, normalizedTarget);
  }

  static async findExactMatch(normalizedQuestion, normalizedTarget) {
    const pool = getDbPool();
    if (!pool) return null;

    await ensureTable();
    const [rows] =
      normalizedTarget === "all"
        ? await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
                AND normalized_question = ?
              ORDER BY CASE WHEN target = 'all' THEN 0 ELSE 1 END, display_order ASC, id DESC
              LIMIT 5`,
            [normalizedQuestion],
          )
        : await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
                AND normalized_question = ?
                AND target IN ('all', ?)
              ORDER BY CASE WHEN target = ? THEN 0 ELSE 1 END, display_order ASC, id DESC
              LIMIT 5`,
            [normalizedQuestion, normalizedTarget, normalizedTarget],
          );

    return rows[0] ? mapRow(rows[0]) : null;
  }

  static async findFuzzyMatch(normalizedQuestion, normalizedTarget, minThreshold = 0.7) {
    const pool = getDbPool();
    if (!pool) return null;

    await ensureTable();
    const [rows] =
      normalizedTarget === "all"
        ? await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
              ORDER BY display_order ASC, id DESC
              LIMIT 50`,
          )
        : await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
                AND target IN ('all', ?)
              ORDER BY CASE WHEN target = ? THEN 0 ELSE 1 END, display_order ASC, id DESC
              LIMIT 50`,
            [normalizedTarget, normalizedTarget],
          );

    if (rows.length === 0) {
      return null;
    }

    const { segmentWords } = require("../services/thaiTextUtils");
    const questionTokens = new Set(segmentWords(normalizedQuestion));

    // Calculate token overlap for each candidate
    const candidates = rows.map(row => {
      const rowTokens = new Set(segmentWords(row.normalized_question));
      
      const intersection = new Set([...questionTokens].filter(x => rowTokens.has(x)));
      const union = new Set([...questionTokens, ...rowTokens]);
      
      const jaccardSimilarity = intersection.size / union.size;
      const tokenCoverage = intersection.size / questionTokens.size;
      
      // Combined score: 70% Jaccard, 30% coverage
      const similarity = (jaccardSimilarity * 0.7) + (tokenCoverage * 0.3);
      
      return {
        ...mapRow(row),
        similarity
      };
    });

    // Filter by threshold and sort by similarity
    const matches = candidates
      .filter(candidate => candidate.similarity >= minThreshold)
      .sort((a, b) => b.similarity - a.similarity);

    return matches[0] || null;
  }
}

module.exports = LawChatbotSuggestedQuestionModel;
