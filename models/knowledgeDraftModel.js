const { getDbPool } = require("../config/db");

const memoryKnowledgeDrafts = [];
const DRAFT_STATUSES = new Set(["draft", "approved", "rejected"]);
const DRAFT_CONFIDENCE = new Set(["high", "medium", "low"]);
const DRAFT_APPROVED_RECORD_TYPES = new Set(["knowledge", "suggested_question"]);
const DRAFT_TARGETS = new Set(["coop", "group", "all", "general"]);

function normalizeKnowledgeDraftSourceId(value) {
  const normalized = Number(value || 0);
  return normalized > 0 ? normalized : null;
}

function normalizeKnowledgeDraftStatus(value, fallback = "draft") {
  const normalized = String(value || "").trim().toLowerCase();
  return DRAFT_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeKnowledgeDraftConfidence(value, fallback = "medium") {
  const normalized = String(value || "").trim().toLowerCase();
  return DRAFT_CONFIDENCE.has(normalized) ? normalized : fallback;
}

function normalizeKnowledgeDraftTarget(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return DRAFT_TARGETS.has(normalized) ? normalized : null;
}

function normalizeKnowledgeDraftRecordType(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return DRAFT_APPROVED_RECORD_TYPES.has(normalized) ? normalized : null;
}

function normalizeKnowledgeDraftRecordId(value) {
  const normalized = Number(value || 0);
  return normalized > 0 ? normalized : null;
}

function normalizeKnowledgeDraftText(value) {
  return String(value || "").trim();
}

function normalizeKnowledgeDraftQuestion(value) {
  return String(value || "").trim().slice(0, 500);
}

function normalizeKnowledgeDraftKeywordsJson(value) {
  if (value == null) {
    return null;
  }

  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    return normalized.length ? JSON.stringify(Array.from(new Set(normalized))) : null;
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) || (parsed && typeof parsed === "object")) {
      return JSON.stringify(parsed);
    }
  } catch (_) {}

  return JSON.stringify(
    trimmed
      .split(/[\n,]/)
      .map((item) => String(item || "").trim())
      .filter(Boolean),
  );
}

function parseKnowledgeDraftKeywordsJson(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch (_) {
    return [normalized];
  }
}

function normalizeEntry(entry = {}) {
  const sourceId = normalizeKnowledgeDraftSourceId(entry.sourceId || entry.source_id);
  const status = normalizeKnowledgeDraftStatus(entry.status);
  const approvedTarget =
    entry.approvedTarget !== undefined || entry.approved_target !== undefined
      ? normalizeKnowledgeDraftTarget(entry.approvedTarget || entry.approved_target)
      : null;
  const approvedRecordType =
    entry.approvedRecordType !== undefined || entry.approved_record_type !== undefined
      ? normalizeKnowledgeDraftRecordType(entry.approvedRecordType || entry.approved_record_type)
      : null;

  return {
    sourceId,
    question: normalizeKnowledgeDraftQuestion(entry.question),
    shortAnswer: normalizeKnowledgeDraftText(entry.shortAnswer || entry.short_answer),
    detailedAnswer: normalizeKnowledgeDraftText(entry.detailedAnswer || entry.detailed_answer),
    keywordsJson: normalizeKnowledgeDraftKeywordsJson(entry.keywordsJson || entry.keywords_json),
    confidence: normalizeKnowledgeDraftConfidence(entry.confidence),
    notes: normalizeKnowledgeDraftText(entry.notes),
    status,
    approvedTarget,
    approvedRecordType,
    approvedRecordId: normalizeKnowledgeDraftRecordId(entry.approvedRecordId || entry.approved_record_id),
  };
}

function mapRow(row = {}) {
  const keywordsJson = row.keywords_json || row.keywordsJson || "";
  return {
    id: row.id,
    sourceId: Number(row.source_id || row.sourceId || 0) || null,
    question: row.question || "",
    shortAnswer: row.short_answer || row.shortAnswer || "",
    detailedAnswer: row.detailed_answer || row.detailedAnswer || "",
    keywordsJson,
    keywords: parseKnowledgeDraftKeywordsJson(keywordsJson),
    confidence: row.confidence || "medium",
    notes: row.notes || "",
    status: row.status || "draft",
    approvedTarget: row.approved_target || row.approvedTarget || null,
    approvedRecordType: row.approved_record_type || row.approvedRecordType || null,
    approvedRecordId: Number(row.approved_record_id || row.approvedRecordId || 0) || null,
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
        CREATE TABLE IF NOT EXISTS knowledge_drafts (
          id int(11) NOT NULL AUTO_INCREMENT,
          source_id int(11) NOT NULL,
          question varchar(500) NOT NULL,
          short_answer text NOT NULL,
          detailed_answer longtext DEFAULT NULL,
          keywords_json text DEFAULT NULL,
          confidence enum('high','medium','low') NOT NULL DEFAULT 'medium',
          notes text DEFAULT NULL,
          status enum('draft','approved','rejected') NOT NULL DEFAULT 'draft',
          approved_target enum('coop','group','all','general') DEFAULT NULL,
          approved_record_type enum('knowledge','suggested_question') DEFAULT NULL,
          approved_record_id int(11) DEFAULT NULL,
          created_at timestamp NULL DEFAULT current_timestamp(),
          updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_knowledge_drafts_source_id (source_id),
          KEY idx_knowledge_drafts_status (status),
          KEY idx_knowledge_drafts_source_status (source_id, status),
          KEY idx_knowledge_drafts_approved_record_type_id (approved_record_type, approved_record_id),
          CONSTRAINT fk_knowledge_drafts_source
            FOREIGN KEY (source_id) REFERENCES knowledge_sources(id)
            ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
      `)
      .then(async () => {
        try {
          await pool.query("ALTER TABLE knowledge_drafts ADD KEY idx_knowledge_drafts_source_status (source_id, status)");
        } catch (_) {}

        try {
          await pool.query(
            "ALTER TABLE knowledge_drafts ADD KEY idx_knowledge_drafts_approved_record_type_id (approved_record_type, approved_record_id)",
          );
        } catch (_) {}
      })
      .catch((error) => {
        tableReadyPromise = null;
        throw error;
      });
  }

  await tableReadyPromise;
}

class KnowledgeDraftModel {
  static async create(entry = {}) {
    const normalized = normalizeEntry(entry);
    if (!normalized.sourceId || !normalized.question || !normalized.shortAnswer) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      const record = {
        id: memoryKnowledgeDrafts.length + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...normalized,
      };
      memoryKnowledgeDrafts.unshift(record);
      return mapRow({
        id: record.id,
        source_id: record.sourceId,
        question: record.question,
        short_answer: record.shortAnswer,
        detailed_answer: record.detailedAnswer,
        keywords_json: record.keywordsJson,
        confidence: record.confidence,
        notes: record.notes,
        status: record.status,
        approved_target: record.approvedTarget,
        approved_record_type: record.approvedRecordType,
        approved_record_id: record.approvedRecordId,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
    }

    await ensureTable();
    const [result] = await pool.query(
      `INSERT INTO knowledge_drafts
        (source_id, question, short_answer, detailed_answer, keywords_json, confidence, notes, status, approved_target, approved_record_type, approved_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.sourceId,
        normalized.question,
        normalized.shortAnswer,
        normalized.detailedAnswer || null,
        normalized.keywordsJson || null,
        normalized.confidence,
        normalized.notes || null,
        normalized.status,
        normalized.approvedTarget || null,
        normalized.approvedRecordType || null,
        normalized.approvedRecordId,
      ],
    );

    return mapRow({
      id: result.insertId,
      source_id: normalized.sourceId,
      question: normalized.question,
      short_answer: normalized.shortAnswer,
      detailed_answer: normalized.detailedAnswer,
      keywords_json: normalized.keywordsJson,
      confidence: normalized.confidence,
      notes: normalized.notes,
      status: normalized.status,
      approved_target: normalized.approvedTarget,
      approved_record_type: normalized.approvedRecordType,
      approved_record_id: normalized.approvedRecordId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  static async findById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      const found = memoryKnowledgeDrafts.find((item) => Number(item.id) === normalizedId);
      return found ? mapRow(found) : null;
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT id, source_id, question, short_answer, detailed_answer, keywords_json, confidence, notes, status, approved_target, approved_record_type, approved_record_id, created_at, updated_at
         FROM knowledge_drafts
        WHERE id = ?
        LIMIT 1`,
      [normalizedId],
    );

    return rows[0] ? mapRow(rows[0]) : null;
  }

  static async listBySourceId(sourceId, options = {}) {
    const normalizedSourceId = Number(sourceId || 0);
    if (!normalizedSourceId) {
      return [];
    }

    const normalizedStatus =
      options.status === undefined || options.status === null
        ? "all"
        : normalizeKnowledgeDraftStatus(options.status, "all");
    const normalizedLimit = Math.max(1, Number(options.limit || 50));
    const normalizedOffset = Math.max(0, Number(options.offset || 0));
    const pool = getDbPool();

    if (!pool) {
      return memoryKnowledgeDrafts
        .filter((item) => {
          const matchesSource = Number(item.sourceId) === normalizedSourceId;
          const matchesStatus =
            normalizedStatus === "all" || normalizeKnowledgeDraftStatus(item.status) === normalizedStatus;
          return matchesSource && matchesStatus;
        })
        .sort((left, right) => {
          const updatedDiff = new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
          if (updatedDiff !== 0) {
            return updatedDiff;
          }

          return Number(right.id || 0) - Number(left.id || 0);
        })
        .slice(normalizedOffset, normalizedOffset + normalizedLimit)
        .map(mapRow);
    }

    await ensureTable();
    const [rows] =
      normalizedStatus === "all"
        ? await pool.query(
            `SELECT id, source_id, question, short_answer, detailed_answer, keywords_json, confidence, notes, status, approved_target, approved_record_type, approved_record_id, created_at, updated_at
               FROM knowledge_drafts
              WHERE source_id = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [normalizedSourceId, normalizedLimit, normalizedOffset],
          )
        : await pool.query(
            `SELECT id, source_id, question, short_answer, detailed_answer, keywords_json, confidence, notes, status, approved_target, approved_record_type, approved_record_id, created_at, updated_at
               FROM knowledge_drafts
              WHERE source_id = ?
                AND status = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [normalizedSourceId, normalizedStatus, normalizedLimit, normalizedOffset],
          );

    return rows.map(mapRow);
  }

  static async listByStatus(status = "draft", limit = 50, offset = 0) {
    const normalizedStatus = normalizeKnowledgeDraftStatus(status, "all");
    const normalizedLimit = Math.max(1, Number(limit || 50));
    const normalizedOffset = Math.max(0, Number(offset || 0));
    const pool = getDbPool();

    if (!pool) {
      return memoryKnowledgeDrafts
        .filter((item) => normalizedStatus === "all" || normalizeKnowledgeDraftStatus(item.status) === normalizedStatus)
        .sort((left, right) => {
          const updatedDiff = new Date(right.updatedAt || 0).getTime() - new Date(left.updatedAt || 0).getTime();
          if (updatedDiff !== 0) {
            return updatedDiff;
          }

          return Number(right.id || 0) - Number(left.id || 0);
        })
        .slice(normalizedOffset, normalizedOffset + normalizedLimit)
        .map(mapRow);
    }

    await ensureTable();
    const [rows] =
      normalizedStatus === "all"
        ? await pool.query(
            `SELECT id, source_id, question, short_answer, detailed_answer, keywords_json, confidence, notes, status, approved_target, approved_record_type, approved_record_id, created_at, updated_at
               FROM knowledge_drafts
              ORDER BY updated_at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [normalizedLimit, normalizedOffset],
          )
        : await pool.query(
            `SELECT id, source_id, question, short_answer, detailed_answer, keywords_json, confidence, notes, status, approved_target, approved_record_type, approved_record_id, created_at, updated_at
               FROM knowledge_drafts
              WHERE status = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [normalizedStatus, normalizedLimit, normalizedOffset],
          );

    return rows.map(mapRow);
  }

  static async listRecent(limit = 20, offset = 0) {
    return this.listByStatus("all", limit, offset);
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
      sourceId: patch.sourceId !== undefined ? patch.sourceId : existing.sourceId,
      question: patch.question !== undefined ? patch.question : existing.question,
      shortAnswer: patch.shortAnswer !== undefined ? patch.shortAnswer : existing.shortAnswer,
      detailedAnswer: patch.detailedAnswer !== undefined ? patch.detailedAnswer : existing.detailedAnswer,
      keywordsJson: patch.keywordsJson !== undefined ? patch.keywordsJson : existing.keywordsJson,
      confidence: patch.confidence !== undefined ? patch.confidence : existing.confidence,
      notes: patch.notes !== undefined ? patch.notes : existing.notes,
      status: patch.status !== undefined ? patch.status : existing.status,
      approvedTarget:
        patch.approvedTarget !== undefined ? patch.approvedTarget : existing.approvedTarget,
      approvedRecordType:
        patch.approvedRecordType !== undefined ? patch.approvedRecordType : existing.approvedRecordType,
      approvedRecordId:
        patch.approvedRecordId !== undefined ? patch.approvedRecordId : existing.approvedRecordId,
    });

    if (!normalized.sourceId || !normalized.question || !normalized.shortAnswer) {
      return false;
    }

    const pool = getDbPool();
    if (!pool) {
      const found = memoryKnowledgeDrafts.find((item) => Number(item.id) === normalizedId);
      if (!found) {
        return false;
      }

      Object.assign(found, {
        sourceId: normalized.sourceId,
        question: normalized.question,
        shortAnswer: normalized.shortAnswer,
        detailedAnswer: normalized.detailedAnswer,
        keywordsJson: normalized.keywordsJson,
        confidence: normalized.confidence,
        notes: normalized.notes,
        status: normalized.status,
        approvedTarget: normalized.approvedTarget,
        approvedRecordType: normalized.approvedRecordType,
        approvedRecordId: normalized.approvedRecordId,
        updatedAt: new Date().toISOString(),
      });

      return true;
    }

    await ensureTable();
    const [result] = await pool.query(
      `UPDATE knowledge_drafts
          SET source_id = ?,
              question = ?,
              short_answer = ?,
              detailed_answer = ?,
              keywords_json = ?,
              confidence = ?,
              notes = ?,
              status = ?,
              approved_target = ?,
              approved_record_type = ?,
              approved_record_id = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        LIMIT 1`,
      [
        normalized.sourceId,
        normalized.question,
        normalized.shortAnswer,
        normalized.detailedAnswer || null,
        normalized.keywordsJson || null,
        normalized.confidence,
        normalized.notes || null,
        normalized.status,
        normalized.approvedTarget || null,
        normalized.approvedRecordType || null,
        normalized.approvedRecordId,
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
      const index = memoryKnowledgeDrafts.findIndex((item) => Number(item.id) === normalizedId);
      if (index === -1) {
        return false;
      }

      memoryKnowledgeDrafts.splice(index, 1);
      return true;
    }

    await ensureTable();
    const [result] = await pool.query("DELETE FROM knowledge_drafts WHERE id = ? LIMIT 1", [normalizedId]);
    return Number(result.affectedRows || 0) > 0;
  }
}

module.exports = KnowledgeDraftModel;
