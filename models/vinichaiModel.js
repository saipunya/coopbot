const { getDbPool } = require("../config/db");
const {
  makeBigrams,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

const memoryVinichaiEntries = [];

function getTodayDateInput() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeDateInput(value, fallback = getTodayDateInput()) {
  const text = String(value || "").trim();
  if (!text) {
    return fallback;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }

  return date.toISOString().slice(0, 10);
}

function normalizeText(value, maxLength = 0) {
  const text = String(value || "").trim();
  if (!maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

function normalizeEntry(entry = {}, options = {}) {
  const fallbackDate = options.vinSavedate || getTodayDateInput();
  return {
    vinGroup: normalizeText(entry.vinGroup || entry.vin_group || entry.group || "", 255),
    vinKey: normalizeText(entry.vinKey || entry.vin_key || entry.key || ""),
    vinQuestion: normalizeText(entry.vinQuestion || entry.vin_question || entry.question || ""),
    vinDetail: normalizeText(entry.vinDetail || entry.vin_detail || entry.detail || ""),
    vinMaihed: normalizeText(entry.vinMaihed || entry.vin_maihed || entry.maihed || ""),
    vinSaveBy: normalizeText(entry.vinSaveBy || entry.vin_saveby || options.vinSaveBy || options.saveBy || "", 255),
    vinSavedate: normalizeDateInput(
      entry.vinSavedate || entry.vin_savedate || entry.savedate || options.vinSavedate || fallbackDate,
      fallbackDate,
    ),
  };
}

function mapRow(row) {
  return {
    id: Number(row.vin_id || row.id || 0) || null,
    vinGroup: row.vin_group || row.vinGroup || "",
    vinKey: row.vin_key || row.vinKey || "",
    vinQuestion: row.vin_question || row.vinQuestion || "",
    vinDetail: row.vin_detail || row.vinDetail || "",
    vinMaihed: row.vin_maihed || row.vinMaihed || "",
    vinSaveBy: row.vin_saveby || row.vinSaveBy || "",
    vinSavedate: row.vin_savedate || row.vinSavedate || "",
  };
}

function buildSearchTerms(query) {
  const normalizedQuery = normalizeForSearch(String(query || "")).toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  const terms = uniqueTokens([
    ...segmentWords(normalizedQuery),
    normalizedQuery,
  ]).filter((term) => term && term.length >= 2);

  return uniqueTokens(terms).slice(0, 8);
}

function getRowSearchText(row = {}) {
  return normalizeForSearch(
    [
      row.vinGroup,
      row.vinKey,
      row.vinQuestion,
      row.vinDetail,
      row.vinMaihed,
      row.vinSaveBy,
      row.vinSavedate,
    ]
      .filter(Boolean)
      .join(" "),
  ).toLowerCase();
}

function scoreRowForQuery(query, row = {}) {
  const normalizedQuery = normalizeForSearch(String(query || "")).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }

  const searchText = getRowSearchText(row);
  const queryTerms = buildSearchTerms(query);
  const rowTerms = uniqueTokens(segmentWords(searchText));
  const rowTermSet = new Set(rowTerms);
  const queryBigrams = makeBigrams(queryTerms);
  let score = 0;

  if (searchText.includes(normalizedQuery)) {
    score += 32;
  }

  const tokenHits = queryTerms.filter((term) => rowTermSet.has(term)).length;
  score += tokenHits * 8;

  for (const bigram of queryBigrams) {
    if (searchText.includes(bigram)) {
      score += 10;
    }
  }

  if (String(row.vinQuestion || "").trim()) {
    score += 8;
  }

  if (String(row.vinKey || "").trim()) {
    score += 4;
  }

  return score + Math.round((tokenHits / Math.max(1, queryTerms.length)) * 18);
}

class VinichaiModel {
  static async count() {
    const pool = getDbPool();
    if (!pool) {
      return memoryVinichaiEntries.length;
    }

    const [rows] = await pool.query("SELECT COUNT(*) AS total FROM tbl_vinichai");
    return Number(rows[0]?.total || 0);
  }

  static async findById(id) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return null;
    }

    const pool = getDbPool();
    if (!pool) {
      const found = memoryVinichaiEntries.find((row) => Number(row.vin_id) === normalizedId);
      return found ? mapRow(found) : null;
    }

    const [rows] = await pool.query(
      `SELECT vin_id, vin_group, vin_key, vin_question, vin_detail, vin_maihed, vin_saveby, vin_savedate
       FROM tbl_vinichai
       WHERE vin_id = ?
       LIMIT 1`,
      [normalizedId],
    );

    return rows[0] ? mapRow(rows[0]) : null;
  }

  static async listForAdmin({ query = "", limit = 12, offset = 0 } = {}) {
    const normalizedLimit = Math.max(1, Number(limit || 12));
    const normalizedOffset = Math.max(0, Number(offset || 0));
    const terms = buildSearchTerms(query);
    const pool = getDbPool();

    if (!pool) {
      const ranked = memoryVinichaiEntries
        .map((row) => ({
          ...mapRow(row),
          score: scoreRowForQuery(query, row),
          sortDate: row.vin_savedate || "",
        }))
        .filter((row) => (terms.length === 0 ? true : row.score > 0))
        .sort((a, b) => (b.score - a.score) || String(b.sortDate || "").localeCompare(String(a.sortDate || "")) || (Number(b.id || 0) - Number(a.id || 0)));

      return ranked.slice(normalizedOffset, normalizedOffset + normalizedLimit).map((row) => {
        const { score, sortDate, ...rest } = row;
        return rest;
      });
    }

    const whereClause = terms.length
      ? terms
          .map(
            () =>
              `(LOWER(vin_group) LIKE ? OR LOWER(vin_key) LIKE ? OR LOWER(vin_question) LIKE ? OR LOWER(vin_detail) LIKE ? OR LOWER(vin_maihed) LIKE ? OR LOWER(vin_saveby) LIKE ? OR LOWER(CAST(vin_savedate AS CHAR)) LIKE ?)`
          )
          .join(" OR ")
      : "1=1";

    const params = terms.length
      ? terms.flatMap((term) => {
          const like = `%${term}%`;
          return [like, like, like, like, like, like, like];
        })
      : [];

    const [rows] = await pool.query(
      `SELECT vin_id, vin_group, vin_key, vin_question, vin_detail, vin_maihed, vin_saveby, vin_savedate
       FROM tbl_vinichai
       WHERE ${whereClause}
       ORDER BY vin_savedate DESC, vin_id DESC
       LIMIT ? OFFSET ?`,
      [...params, normalizedLimit, normalizedOffset],
    );

    return rows.map(mapRow);
  }

  static async countForAdmin(query = "") {
    const terms = buildSearchTerms(query);
    const pool = getDbPool();

    if (!pool) {
      if (terms.length === 0) {
        return memoryVinichaiEntries.length;
      }

      return memoryVinichaiEntries.filter((row) => scoreRowForQuery(query, row) > 0).length;
    }

    const whereClause = terms.length
      ? terms
          .map(
            () =>
              `(LOWER(vin_group) LIKE ? OR LOWER(vin_key) LIKE ? OR LOWER(vin_question) LIKE ? OR LOWER(vin_detail) LIKE ? OR LOWER(vin_maihed) LIKE ? OR LOWER(vin_saveby) LIKE ? OR LOWER(CAST(vin_savedate AS CHAR)) LIKE ?)`
          )
          .join(" OR ")
      : "1=1";

    const params = terms.length
      ? terms.flatMap((term) => {
          const like = `%${term}%`;
          return [like, like, like, like, like, like, like];
        })
      : [];

    const [rows] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM tbl_vinichai
       WHERE ${whereClause}`,
      params,
    );

    return Number(rows[0]?.total || 0);
  }

  static async create(entry, options = {}) {
    const normalized = normalizeEntry(entry, options);
    const pool = getDbPool();

    if (!pool) {
      const record = {
        vin_id: memoryVinichaiEntries.length + 1,
        vin_group: normalized.vinGroup,
        vin_key: normalized.vinKey,
        vin_question: normalized.vinQuestion,
        vin_detail: normalized.vinDetail,
        vin_maihed: normalized.vinMaihed,
        vin_saveby: normalized.vinSaveBy,
        vin_savedate: normalized.vinSavedate,
      };
      memoryVinichaiEntries.unshift(record);
      return mapRow(record);
    }

    const [result] = await pool.query(
      `INSERT INTO tbl_vinichai
        (vin_group, vin_key, vin_question, vin_detail, vin_maihed, vin_saveby, vin_savedate)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        normalized.vinGroup,
        normalized.vinKey,
        normalized.vinQuestion,
        normalized.vinDetail,
        normalized.vinMaihed,
        normalized.vinSaveBy || options.saveBy || "admin",
        normalized.vinSavedate,
      ],
    );

    return {
      id: result.insertId,
      vinGroup: normalized.vinGroup,
      vinKey: normalized.vinKey,
      vinQuestion: normalized.vinQuestion,
      vinDetail: normalized.vinDetail,
      vinMaihed: normalized.vinMaihed,
      vinSaveBy: normalized.vinSaveBy || options.saveBy || "admin",
      vinSavedate: normalized.vinSavedate,
    };
  }

  static async updateById(id, patch = {}, options = {}) {
    const normalizedId = Number(id || 0);
    if (!normalizedId) {
      return false;
    }

    const current = await this.findById(normalizedId);
    if (!current) {
      return false;
    }

    const merged = normalizeEntry(
      {
        ...current,
        ...patch,
      },
      {
        saveBy: options.saveBy || patch.vinSaveBy || patch.vin_saveby || current.vinSaveBy,
        vinSavedate: options.vinSavedate || patch.vinSavedate || patch.vin_savedate || current.vinSavedate,
      },
    );

    const pool = getDbPool();
    if (!pool) {
      const index = memoryVinichaiEntries.findIndex((row) => Number(row.vin_id) === normalizedId);
      if (index === -1) {
        return false;
      }

      memoryVinichaiEntries[index] = {
        vin_id: normalizedId,
        vin_group: merged.vinGroup,
        vin_key: merged.vinKey,
        vin_question: merged.vinQuestion,
        vin_detail: merged.vinDetail,
        vin_maihed: merged.vinMaihed,
        vin_saveby: merged.vinSaveBy,
        vin_savedate: merged.vinSavedate,
      };
      return true;
    }

    const [result] = await pool.query(
      `UPDATE tbl_vinichai
       SET vin_group = ?,
           vin_key = ?,
           vin_question = ?,
           vin_detail = ?,
           vin_maihed = ?,
           vin_saveby = ?,
           vin_savedate = ?
       WHERE vin_id = ?
       LIMIT 1`,
      [
        merged.vinGroup,
        merged.vinKey,
        merged.vinQuestion,
        merged.vinDetail,
        merged.vinMaihed,
        merged.vinSaveBy || options.saveBy || "admin",
        merged.vinSavedate,
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
      const index = memoryVinichaiEntries.findIndex((row) => Number(row.vin_id) === normalizedId);
      if (index === -1) {
        return false;
      }

      memoryVinichaiEntries.splice(index, 1);
      return true;
    }

    const [result] = await pool.query(
      "DELETE FROM tbl_vinichai WHERE vin_id = ? LIMIT 1",
      [normalizedId],
    );

    return Number(result.affectedRows || 0) > 0;
  }
}

module.exports = VinichaiModel;
