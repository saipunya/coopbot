const { getDbPool } = require("../config/db");
const {
  normalizeForSearch,
  scoreQueryFocusAlignment,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

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
const SUGGESTED_QUESTION_TARGETS = new Set(["all", "coop", "group", "general"]);

function invalidateAnswerCache() {
  const { clearAnswerCache } = require("../services/answerStateService");
  clearAnswerCache();
}

function normalizeQuestionText(value) {
  return normalizeForSearch(String(value || "")).toLowerCase();
}

function buildSuggestedQuestionSearchText(entry = {}) {
  return normalizeForSearch(
    [
      entry.normalized_question,
      entry.normalizedQuestion,
      entry.question_text,
      entry.questionText,
      entry.source_reference,
      entry.sourceReference,
      entry.answer_text,
      entry.answerText,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();
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

function normalizeSuggestedQuestionTarget(value, fallback = "all") {
  const normalized = String(value || "").trim().toLowerCase();
  return SUGGESTED_QUESTION_TARGETS.has(normalized) ? normalized : fallback;
}

function getSuggestedQuestionTargetPriority(candidateTarget, requestedTarget) {
  const candidate = normalizeSuggestedQuestionTarget(candidateTarget);
  const requested = normalizeSuggestedQuestionTarget(requestedTarget);

  if (requested === "all") {
    if (candidate === "all") {
      return 0;
    }
    if (candidate === "general") {
      return 1;
    }
    return 2;
  }

  if (candidate === requested) {
    return 0;
  }

  if (candidate === "general") {
    return 1;
  }

  if (candidate === "all") {
    return 2;
  }

  return 3;
}

function getSuggestedQuestionLookupTargets(target) {
  const normalizedTarget = normalizeSuggestedQuestionTarget(target);

  if (normalizedTarget === "all") {
    return {
      normalizedTarget,
      lookupTargets: null,
    };
  }

  if (normalizedTarget === "general") {
    return {
      normalizedTarget,
      lookupTargets: ["general", "all"],
    };
  }

  return {
    normalizedTarget,
    lookupTargets: [normalizedTarget, "general", "all"],
  };
}

function normalizeEntry(entry = {}) {
  const rawDisplayOrder = Number(entry.displayOrder);

  return {
    domain: normalizeSuggestedQuestionDomain(entry.domain),
    target: normalizeSuggestedQuestionTarget(entry.target),
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
    target: normalizeSuggestedQuestionTarget(row.target),
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
          target ENUM('all', 'coop', 'group', 'general') NOT NULL DEFAULT 'all',
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
      await pool.query(
        "ALTER TABLE chatbot_suggested_questions MODIFY COLUMN target enum('all','coop','group','general') NOT NULL DEFAULT 'all'",
      );

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
      invalidateAnswerCache();
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

    invalidateAnswerCache();

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
    const { normalizedTarget, lookupTargets } = getSuggestedQuestionLookupTargets(target);
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

          const itemTarget = normalizeSuggestedQuestionTarget(item.target);
          return lookupTargets.includes(itemTarget);
        })
        .sort((left, right) => {
          if (normalizedTarget !== "all") {
            const targetDiff =
              getSuggestedQuestionTargetPriority(left.target, normalizedTarget) -
              getSuggestedQuestionTargetPriority(right.target, normalizedTarget);
            if (targetDiff !== 0) {
              return targetDiff;
            }
          }

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
                AND target IN (${lookupTargets.map(() => "?").join(", ")})
              ORDER BY CASE
                         WHEN target = ? THEN 0
                         WHEN target = 'general' THEN 1
                         WHEN target = 'all' THEN 2
                         ELSE 3
                       END,
                       display_order ASC, id DESC
              LIMIT ?`,
            [...lookupTargets, normalizedTarget, normalizedLimit],
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
      invalidateAnswerCache();
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

    const updated = Number(result.affectedRows || 0) > 0;
    if (updated) {
      invalidateAnswerCache();
    }

    return updated;
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
      invalidateAnswerCache();
      return true;
    }

    await ensureTable();
    const [result] = await pool.query(
      "DELETE FROM chatbot_suggested_questions WHERE id = ? LIMIT 1",
      [normalizedId],
    );

    const removed = Number(result.affectedRows || 0) > 0;
    if (removed) {
      invalidateAnswerCache();
    }

    return removed;
  }

  static async findAnswerMatch(question, target = "all") {
    const normalizedQuestion = normalizeQuestionText(question);
    if (!normalizedQuestion) {
      return null;
    }

    const { normalizedTarget, lookupTargets } = getSuggestedQuestionLookupTargets(target);
    const pool = getDbPool();

    const sortMatches = (items) =>
      items.sort((left, right) => {
        const priorityDiff =
          getSuggestedQuestionTargetPriority(left.target, normalizedTarget) -
          getSuggestedQuestionTargetPriority(right.target, normalizedTarget);
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
      const exactMatch = sortMatches(
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

            return lookupTargets.includes(normalizeSuggestedQuestionTarget(item.target));
          })
          .map(mapRow),
      )[0];

      if (exactMatch) {
        return exactMatch;
      }

      return this.findFuzzyMatchInMemory(normalizedQuestion, normalizedTarget);
    }

    // Try exact match first
    const exactMatch = await this.findExactMatch(normalizedQuestion, normalizedTarget);
    if (exactMatch) {
      return exactMatch;
    }

    // Try fuzzy matching if no exact match
    return await this.findFuzzyMatch(normalizedQuestion, normalizedTarget);
  }

  static scoreFuzzyCandidate(normalizedQuestion, row = {}) {
    const { segmentWords } = require("../services/thaiTextUtils");

    const normalizedSearchText = buildSuggestedQuestionSearchText(row);
    if (!normalizedSearchText) {
      return null;
    }

    const questionTokens = new Set(segmentWords(normalizedQuestion));
    const rowTokens = new Set(segmentWords(normalizedSearchText));
    if (questionTokens.size === 0 || rowTokens.size === 0) {
      return null;
    }

    const intersection = new Set([...questionTokens].filter((token) => rowTokens.has(token)));
    const union = new Set([...questionTokens, ...rowTokens]);

    const jaccardSimilarity = union.size > 0 ? intersection.size / union.size : 0;
    const tokenCoverage = questionTokens.size > 0 ? intersection.size / questionTokens.size : 0;
    const focusScore = scoreQueryFocusAlignment(normalizedQuestion, normalizedSearchText);
    const normalizedReference = normalizeQuestionText(row.source_reference || row.sourceReference || "");
    const normalizedStoredQuestion = normalizeQuestionText(
      row.normalized_question || row.normalizedQuestion || row.question_text || row.questionText || "",
    );

    let similarity = (jaccardSimilarity * 0.55) + (tokenCoverage * 0.35) + (Math.max(0, focusScore) * 0.01);

    if (normalizedReference && normalizedQuestion.includes(normalizedReference)) {
      similarity += 0.22;
    } else if (normalizedReference && normalizedReference.includes(normalizedQuestion)) {
      similarity += 0.16;
    }

    if (normalizedStoredQuestion && normalizedQuestion.includes(normalizedStoredQuestion)) {
      similarity += 0.12;
    } else if (normalizedStoredQuestion && normalizedStoredQuestion.includes(normalizedQuestion)) {
      similarity += 0.16;
    }

    return {
      similarity,
      tokenCoverage,
      jaccardSimilarity,
      focusScore,
    };
  }

  static async findFuzzyMatchInMemory(normalizedQuestion, normalizedTarget, minThreshold = 0.7) {
    const { lookupTargets } = getSuggestedQuestionLookupTargets(normalizedTarget);

    const candidates = memorySuggestedQuestions
      .filter((item) => {
        if (!item.isActive) {
          return false;
        }

        if (normalizedTarget === "all") {
          return true;
        }

        return lookupTargets.includes(normalizeSuggestedQuestionTarget(item.target));
      })
      .map((row) => {
        const scoring = this.scoreFuzzyCandidate(normalizedQuestion, row);
        if (!scoring) {
          return null;
        }

        return {
          ...mapRow(row),
          ...scoring,
        };
      })
      .filter(Boolean)
      .filter((candidate) => candidate.similarity >= minThreshold)
      .sort((left, right) => {
        if (right.similarity !== left.similarity) {
          return right.similarity - left.similarity;
        }

        const priorityDiff =
          getSuggestedQuestionTargetPriority(left.target, normalizedTarget) -
          getSuggestedQuestionTargetPriority(right.target, normalizedTarget);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        const orderDiff = Number(left.displayOrder || 0) - Number(right.displayOrder || 0);
        if (orderDiff !== 0) {
          return orderDiff;
        }

        return Number(right.id || 0) - Number(left.id || 0);
      });

    return candidates[0] || null;
  }

  static async findExactMatch(normalizedQuestion, normalizedTarget) {
    const pool = getDbPool();
    if (!pool) return null;

    await ensureTable();
    const { normalizedTarget: resolvedTarget, lookupTargets } =
      getSuggestedQuestionLookupTargets(normalizedTarget);
    const [rows] =
      resolvedTarget === "all"
        ? await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
                AND normalized_question = ?
              ORDER BY CASE
                         WHEN target = 'all' THEN 0
                         WHEN target = 'general' THEN 1
                         ELSE 2
                       END, display_order ASC, id DESC
              LIMIT 5`,
            [normalizedQuestion],
          )
        : await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
                AND normalized_question = ?
                AND target IN (${lookupTargets.map(() => "?").join(", ")})
              ORDER BY CASE
                         WHEN target = ? THEN 0
                         WHEN target = 'general' THEN 1
                         WHEN target = 'all' THEN 2
                         ELSE 3
                       END, display_order ASC, id DESC
              LIMIT 5`,
            [
              normalizedQuestion,
              ...lookupTargets,
              resolvedTarget,
            ],
          );

    return rows[0] ? mapRow(rows[0]) : null;
  }

  static async findFuzzyMatch(normalizedQuestion, normalizedTarget, minThreshold = 0.7) {
    const pool = getDbPool();
    if (!pool) return null;

    await ensureTable();
    const { normalizedTarget: resolvedTarget, lookupTargets } =
      getSuggestedQuestionLookupTargets(normalizedTarget);
    const searchTerms = uniqueTokens(segmentWords(normalizedQuestion)).slice(0, 8);
    const whereClause = searchTerms.length
      ? searchTerms
        .map(
          () =>
            "(normalized_question LIKE ? OR LOWER(COALESCE(source_reference, '')) LIKE ? OR LOWER(COALESCE(answer_text, '')) LIKE ?)",
        )
        .join(" OR ")
      : "1 = 1";
    const whereParams = searchTerms.flatMap((term) => {
      const like = `%${term}%`;
      return [like, like, like];
    });
    const [rows] =
      resolvedTarget === "all"
        ? await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
                AND (${whereClause})
              ORDER BY display_order ASC, id DESC
              LIMIT 80`,
            whereParams,
          )
        : await pool.query(
            `SELECT ${SUGGESTED_QUESTION_SELECT_COLUMNS}
               FROM chatbot_suggested_questions
              WHERE is_active = 1
                AND target IN (${lookupTargets.map(() => "?").join(", ")})
                AND (${whereClause})
              ORDER BY CASE
                         WHEN target = ? THEN 0
                         WHEN target = 'general' THEN 1
                         WHEN target = 'all' THEN 2
                         ELSE 3
                       END, display_order ASC, id DESC
              LIMIT 80`,
            [
              ...lookupTargets,
              ...whereParams,
              resolvedTarget,
            ],
          );

    if (rows.length === 0) {
      return null;
    }

    const candidates = rows
      .map((row) => {
        const scoring = this.scoreFuzzyCandidate(normalizedQuestion, row);
        if (!scoring) {
          return null;
        }

        return {
          ...mapRow(row),
          ...scoring,
        };
      })
      .filter(Boolean);

    // Filter by threshold and sort by similarity
    const matches = candidates
      .filter((candidate) => candidate.similarity >= minThreshold)
      .sort((a, b) => {
        if (b.similarity !== a.similarity) {
          return b.similarity - a.similarity;
        }

        const priorityDiff =
          getSuggestedQuestionTargetPriority(a.target, resolvedTarget) -
          getSuggestedQuestionTargetPriority(b.target, resolvedTarget);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }

        const orderDiff = Number(a.displayOrder || 0) - Number(b.displayOrder || 0);
        if (orderDiff !== 0) {
          return orderDiff;
        }

        return Number(b.id || 0) - Number(a.id || 0);
      });

    return matches[0] || null;
  }
}

module.exports = LawChatbotSuggestedQuestionModel;
