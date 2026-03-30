const { getDbPool } = require("../config/db");
const {
  makeBigrams,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

function scoreResult(query, text, primaryLabel) {
  const normalizedQuery = normalizeForSearch(query).toLowerCase();
  const normalizedText = normalizeForSearch(text).toLowerCase();
  const queryTokens = uniqueTokens(segmentWords(query));
  const textTokenSet = new Set(uniqueTokens(segmentWords(text)));
  const queryBigrams = makeBigrams(queryTokens);

  let score = 0;

  if (normalizedQuery && normalizedText.includes(normalizedQuery)) {
    score += 35;
  }

  const tokenHits = queryTokens.filter((token) => textTokenSet.has(token)).length;
  score += tokenHits * 8;

  for (const bigram of queryBigrams) {
    if (normalizedText.includes(bigram)) {
      score += 12;
    }
  }

  if (primaryLabel && normalizeForSearch(primaryLabel).toLowerCase().includes(normalizedQuery)) {
    score += 20;
  }

  const coverage = queryTokens.length > 0 ? tokenHits / queryTokens.length : 0;
  score += coverage * 25;

  return score;
}

class LawSearchModel {
  static async searchStructuredLaws(message, target = "coop", limit = 5) {
    const pool = getDbPool();
    if (!pool) {
      return [];
    }

    const terms = uniqueTokens(segmentWords(message)).slice(0, 8);
    if (terms.length === 0) {
      return [];
    }

    const isGroupTarget = target === "group";
    const tableName = isGroupTarget ? "tbl_glaws" : "tbl_laws";
    const idField = isGroupTarget ? "glaw_id" : "law_id";
    const numberField = isGroupTarget ? "glaw_number" : "law_number";
    const partField = isGroupTarget ? "glaw_part" : "law_part";
    const detailField = isGroupTarget ? "glaw_detail" : "law_detail";
    const commentField = isGroupTarget ? "glaw_comment" : "law_comment";
    const sourceName = isGroupTarget ? "tbl_glaws" : "tbl_laws";

    const whereClause = terms
      .map(
        () =>
          `(LOWER(${numberField}) LIKE ? OR LOWER(${partField}) LIKE ? OR LOWER(${detailField}) LIKE ? OR LOWER(${commentField}) LIKE ?)`
      )
      .join(" OR ");
    const params = terms.flatMap((term) => {
      const like = `%${term}%`;
      return [like, like, like, like];
    });

    const [rows] = await pool.query(
      `SELECT ${idField} AS id, ${numberField} AS law_number, ${partField} AS law_part,
              ${detailField} AS law_detail, ${commentField} AS law_comment
       FROM ${tableName}
       WHERE ${whereClause}
       LIMIT 50`,
      params
    );

    return rows
      .map((row) => {
        const combinedText = [
          row.law_number,
          row.law_part,
          row.law_detail,
          row.law_comment,
        ].join(" ");

        return {
          id: row.id,
          source: sourceName,
          title: row.law_part || row.law_number || "กฎหมายที่เกี่ยวข้อง",
          reference: row.law_number || row.law_part || sourceName,
          content: row.law_detail || "",
          comment: row.law_comment || "",
          score: scoreResult(message, combinedText, `${row.law_number} ${row.law_part}`),
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

module.exports = LawSearchModel;
