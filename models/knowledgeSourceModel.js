const { getDbPool } = require("../config/db");
const { normalizeForSearch } = require("../services/thaiTextUtils");

const memoryKnowledgeSources = [];
const SOURCE_DOMAINS = new Set(["legal", "general", "mixed"]);
const SOURCE_TARGETS = new Set(["coop", "group", "all", "general"]);
const SOURCE_STATUSES = new Set(["draft", "approved", "archived"]);

function normalizeKnowledgeSourceDomain(value, fallback = "general") {
  const normalized = String(value || "").trim().toLowerCase();
  return SOURCE_DOMAINS.has(normalized) ? normalized : fallback;
}

function normalizeKnowledgeSourceTarget(value, fallback = "general") {
  const normalized = String(value || "").trim().toLowerCase();
  return SOURCE_TARGETS.has(normalized) ? normalized : fallback;
}

function normalizeKnowledgeSourceStatus(value, fallback = "draft") {
  const normalized = String(value || "").trim().toLowerCase();
  return SOURCE_STATUSES.has(normalized) ? normalized : fallback;
}

function normalizeKnowledgeSourceText(value) {
  return String(value || "").trim();
}

function normalizeKnowledgeSourceReference(value) {
  return String(value || "").trim();
}

function normalizeKnowledgeSourceDocumentType(value) {
  return String(value || "").trim().slice(0, 100);
}

function normalizeKnowledgeSourceActor(value) {
  return String(value || "").trim().slice(0, 255);
}

function normalizeKnowledgeSourceApprovedAt(value, status) {
  if (value) {
    return value;
  }

  return status === "approved" ? new Date().toISOString() : null;
}

function normalizeKnowledgeSourceNormalizedText(value, sourceText) {
  const provided = String(value || "").trim();
  if (provided) {
    return provided;
  }

  const normalized = normalizeForSearch(String(sourceText || "")).toLowerCase().trim();
  return normalized || null;
}

function normalizeEntry(entry = {}) {
  const status = normalizeKnowledgeSourceStatus(entry.status);
  const sourceText = normalizeKnowledgeSourceText(entry.sourceText || entry.source_text);

  return {
    domain: normalizeKnowledgeSourceDomain(entry.domain),
    target: normalizeKnowledgeSourceTarget(entry.target),
    title: String(entry.title || "").trim().slice(0, 255),
    sourceText,
    normalizedText: normalizeKnowledgeSourceNormalizedText(
      entry.normalizedText || entry.normalized_text,
      sourceText,
    ),
    sourceReference: normalizeKnowledgeSourceReference(entry.sourceReference || entry.source_reference),
    documentType: normalizeKnowledgeSourceDocumentType(entry.documentType || entry.document_type),
    status,
    createdBy: normalizeKnowledgeSourceActor(entry.createdBy || entry.created_by),
    approvedBy: normalizeKnowledgeSourceActor(entry.approvedBy || entry.approved_by),
    approvedAt: normalizeKnowledgeSourceApprovedAt(entry.approvedAt || entry.approved_at, status),
  };
}

function mapRow(row = {}) {
  return {
    id: row.id,
    domain: row.domain || "general",
    target: row.target || "general",
    title: row.title || "",
    sourceText: row.source_text || row.sourceText || "",
    normalizedText: row.normalized_text || row.normalizedText || "",
    sourceReference: row.source_reference || row.sourceReference || "",
    documentType: row.document_type || row.documentType || "",
    status: row.status || "draft",
    createdBy: row.created_by || row.createdBy || "",
    approvedBy: row.approved_by || row.approvedBy || "",
    approvedAt: row.approved_at || row.approvedAt || "",
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
        CREATE TABLE IF NOT EXISTS knowledge_sources (
          id int(11) NOT NULL AUTO_INCREMENT,
          domain enum('legal','general','mixed') NOT NULL DEFAULT 'general',
          target enum('coop','group','all','general') NOT NULL DEFAULT 'general',
          title varchar(255) NOT NULL,
          source_text longtext NOT NULL,
          normalized_text longtext DEFAULT NULL,
          source_reference text DEFAULT NULL,
          document_type varchar(100) DEFAULT NULL,
          status enum('draft','approved','archived') NOT NULL DEFAULT 'draft',
          created_by varchar(255) DEFAULT NULL,
          approved_by varchar(255) DEFAULT NULL,
          approved_at timestamp NULL DEFAULT NULL,
          created_at timestamp NULL DEFAULT current_timestamp(),
          updated_at timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
          PRIMARY KEY (id),
          KEY idx_knowledge_sources_domain_target_status (domain, target, status),
          KEY idx_knowledge_sources_status (status),
          KEY idx_knowledge_sources_target_status (target, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
      `)
      .then(async () => {
        try {
          await pool.query("ALTER TABLE knowledge_sources ADD KEY idx_knowledge_sources_target_status (target, status)");
        } catch (_) {}
      })
      .catch((error) => {
        tableReadyPromise = null;
        throw error;
      });
  }

  await tableReadyPromise;
}

class KnowledgeSourceModel {
  static async create(entry = {}) {
    const normalized = normalizeEntry(entry);
    if (!normalized.title || !normalized.sourceText) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      const record = {
        id: memoryKnowledgeSources.length + 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...normalized,
      };
      memoryKnowledgeSources.unshift(record);
      return mapRow({
        id: record.id,
        domain: record.domain,
        target: record.target,
        title: record.title,
        source_text: record.sourceText,
        normalized_text: record.normalizedText,
        source_reference: record.sourceReference,
        document_type: record.documentType,
        status: record.status,
        created_by: record.createdBy,
        approved_by: record.approvedBy,
        approved_at: record.approvedAt,
        created_at: record.createdAt,
        updated_at: record.updatedAt,
      });
    }

    await ensureTable();
    const [result] = await pool.query(
      `INSERT INTO knowledge_sources
        (domain, target, title, source_text, normalized_text, source_reference, document_type, status, created_by, approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.domain,
        normalized.target,
        normalized.title,
        normalized.sourceText,
        normalized.normalizedText,
        normalized.sourceReference || null,
        normalized.documentType || null,
        normalized.status,
        normalized.createdBy || null,
        normalized.approvedBy || null,
        normalized.approvedAt || null,
      ],
    );

    return mapRow({
      id: result.insertId,
      domain: normalized.domain,
      target: normalized.target,
      title: normalized.title,
      source_text: normalized.sourceText,
      normalized_text: normalized.normalizedText,
      source_reference: normalized.sourceReference,
      document_type: normalized.documentType,
      status: normalized.status,
      created_by: normalized.createdBy,
      approved_by: normalized.approvedBy,
      approved_at: normalized.approvedAt,
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
      const found = memoryKnowledgeSources.find((item) => Number(item.id) === normalizedId);
      return found ? mapRow(found) : null;
    }

    await ensureTable();
    const [rows] = await pool.query(
      `SELECT id, domain, target, title, source_text, normalized_text, source_reference, document_type, status, created_by, approved_by, approved_at, created_at, updated_at
         FROM knowledge_sources
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
      return memoryKnowledgeSources
        .slice()
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
    const [rows] = await pool.query(
      `SELECT id, domain, target, title, source_text, normalized_text, source_reference, document_type, status, created_by, approved_by, approved_at, created_at, updated_at
         FROM knowledge_sources
        ORDER BY updated_at DESC, id DESC
        LIMIT ? OFFSET ?`,
      [normalizedLimit, normalizedOffset],
    );

    return rows.map(mapRow);
  }

  static async listByStatus(status = "draft", limit = 20, offset = 0) {
    const normalizedLimit = Math.max(1, Number(limit || 20));
    const normalizedOffset = Math.max(0, Number(offset || 0));
    const normalizedStatus = normalizeKnowledgeSourceStatus(status, "all");
    const pool = getDbPool();

    if (!pool) {
      return memoryKnowledgeSources
        .filter((item) => normalizedStatus === "all" || normalizeKnowledgeSourceStatus(item.status) === normalizedStatus)
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
            `SELECT id, domain, target, title, source_text, normalized_text, source_reference, document_type, status, created_by, approved_by, approved_at, created_at, updated_at
               FROM knowledge_sources
              ORDER BY updated_at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [normalizedLimit, normalizedOffset],
          )
        : await pool.query(
            `SELECT id, domain, target, title, source_text, normalized_text, source_reference, document_type, status, created_by, approved_by, approved_at, created_at, updated_at
               FROM knowledge_sources
              WHERE status = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [normalizedStatus, normalizedLimit, normalizedOffset],
          );

    return rows.map(mapRow);
  }

  static async listByTargetStatus(target = "general", status = "draft", limit = 20, offset = 0) {
    const normalizedLimit = Math.max(1, Number(limit || 20));
    const normalizedOffset = Math.max(0, Number(offset || 0));
    const normalizedTarget = normalizeKnowledgeSourceTarget(target, "general");
    const normalizedStatus = normalizeKnowledgeSourceStatus(status, "all");
    const pool = getDbPool();

    if (!pool) {
      return memoryKnowledgeSources
        .filter((item) => {
          const matchesTarget = normalizeKnowledgeSourceTarget(item.target) === normalizedTarget;
          const matchesStatus = normalizedStatus === "all" || normalizeKnowledgeSourceStatus(item.status) === normalizedStatus;
          return matchesTarget && matchesStatus;
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
            `SELECT id, domain, target, title, source_text, normalized_text, source_reference, document_type, status, created_by, approved_by, approved_at, created_at, updated_at
               FROM knowledge_sources
              WHERE target = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [normalizedTarget, normalizedLimit, normalizedOffset],
          )
        : await pool.query(
            `SELECT id, domain, target, title, source_text, normalized_text, source_reference, document_type, status, created_by, approved_by, approved_at, created_at, updated_at
               FROM knowledge_sources
              WHERE target = ?
                AND status = ?
              ORDER BY updated_at DESC, id DESC
              LIMIT ? OFFSET ?`,
            [normalizedTarget, normalizedStatus, normalizedLimit, normalizedOffset],
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
      title: patch.title !== undefined ? patch.title : existing.title,
      sourceText: patch.sourceText !== undefined ? patch.sourceText : existing.sourceText,
      normalizedText: patch.normalizedText !== undefined ? patch.normalizedText : existing.normalizedText,
      sourceReference: patch.sourceReference !== undefined ? patch.sourceReference : existing.sourceReference,
      documentType: patch.documentType !== undefined ? patch.documentType : existing.documentType,
      status: patch.status !== undefined ? patch.status : existing.status,
      createdBy: patch.createdBy !== undefined ? patch.createdBy : existing.createdBy,
      approvedBy: patch.approvedBy !== undefined ? patch.approvedBy : existing.approvedBy,
      approvedAt: patch.approvedAt !== undefined ? patch.approvedAt : existing.approvedAt,
    });

    if (!normalized.title || !normalized.sourceText) {
      return false;
    }

    const pool = getDbPool();
    if (!pool) {
      const found = memoryKnowledgeSources.find((item) => Number(item.id) === normalizedId);
      if (!found) {
        return false;
      }

      Object.assign(found, {
        domain: normalized.domain,
        target: normalized.target,
        title: normalized.title,
        sourceText: normalized.sourceText,
        normalizedText: normalized.normalizedText,
        sourceReference: normalized.sourceReference,
        documentType: normalized.documentType,
        status: normalized.status,
        createdBy: normalized.createdBy,
        approvedBy: normalized.approvedBy,
        approvedAt: normalized.approvedAt,
        updatedAt: new Date().toISOString(),
      });

      return true;
    }

    await ensureTable();
    const [result] = await pool.query(
      `UPDATE knowledge_sources
          SET domain = ?,
              target = ?,
              title = ?,
              source_text = ?,
              normalized_text = ?,
              source_reference = ?,
              document_type = ?,
              status = ?,
              created_by = ?,
              approved_by = ?,
              approved_at = ?,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        LIMIT 1`,
      [
        normalized.domain,
        normalized.target,
        normalized.title,
        normalized.sourceText,
        normalized.normalizedText,
        normalized.sourceReference || null,
        normalized.documentType || null,
        normalized.status,
        normalized.createdBy || null,
        normalized.approvedBy || null,
        normalized.approvedAt || null,
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
      const index = memoryKnowledgeSources.findIndex((item) => Number(item.id) === normalizedId);
      if (index === -1) {
        return false;
      }

      memoryKnowledgeSources.splice(index, 1);
      return true;
    }

    await ensureTable();
    const [result] = await pool.query("DELETE FROM knowledge_sources WHERE id = ? LIMIT 1", [normalizedId]);
    return Number(result.affectedRows || 0) > 0;
  }
}

module.exports = KnowledgeSourceModel;
