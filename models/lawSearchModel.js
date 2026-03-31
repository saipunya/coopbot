const { getDbPool } = require("../config/db");
const {
  makeBigrams,
  normalizeForSearch,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

function extractLawNumber(text) {
  const match = String(text || "").match(/\d+/);
  return match ? match[0] : null;
}

function detectLawScope(text) {
  const normalized = normalizeForSearch(text).toLowerCase();
  const asksCoop = /พรบ|พระราชบัญญัติ|สหกรณ์/.test(normalized);
  const asksGroup = /พรฎ|พระราชกฤษฎีกา|กลุ่มเกษตรกร/.test(normalized);

  if (asksCoop && !asksGroup) {
    return "coop";
  }

  if (asksGroup && !asksCoop) {
    return "group";
  }

  return "all";
}

function buildLawNumberPatterns(number) {
  if (!number) {
    return [];
  }

  return uniqueTokens([
    `มาตรา ${number}`,
    `มาตรา${number}`,
    number,
  ]);
}

function isDirectLawNumberQuery(text) {
  const normalized = normalizeForSearch(text).toLowerCase();
  return /^(มาตรา|ข้อ|วรรค|อนุมาตรา)\s*\d+(?:\s|$)/.test(normalized);
}

async function findExactLawRows(pool, tableConfig, queryLawNumber) {
  const [tableName, idField, numberField, partField, detailField, commentField, sourceName] = tableConfig;
  const number = String(queryLawNumber || "").trim();
  if (!number) {
    return [];
  }

  const exactTerms = [
    `มาตรา ${number}`,
    `มาตรา${number}`,
    `ข้อ ${number}`,
    `ข้อ${number}`,
    number,
  ];

  const [rows] = await pool.query(
    `SELECT ${idField} AS id, ${numberField} AS law_number, ${partField} AS law_part,
            ${detailField} AS law_detail, ${commentField} AS law_comment
       FROM ${tableName}
      WHERE TRIM(${numberField}) IN (?, ?, ?, ?, ?)
         OR REPLACE(TRIM(${numberField}), ' ', '') IN (?, ?, ?, ?, ?)
      LIMIT 20`,
    [...exactTerms, ...exactTerms.map((term) => term.replace(/\s+/g, ""))],
  );

  return rows.map((row) => ({ ...row, __sourceName: sourceName }));
}

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
  static async searchVinichai(message, limit = 5) {
    const pool = getDbPool();
    if (!pool) {
      return [];
    }

    const terms = uniqueTokens(segmentWords(message)).slice(0, 8);
    if (terms.length === 0) {
      return [];
    }

    const whereClause = terms
      .map(
        () =>
          `(LOWER(vin_key) LIKE ? OR LOWER(vin_question) LIKE ? OR LOWER(vin_detail) LIKE ?)`
      )
      .join(" OR ");
    const params = terms.flatMap((term) => {
      const like = `%${term}%`;
      return [like, like, like];
    });

    let rows;
    try {
      [rows] = await pool.query(
        `SELECT id, vin_key, vin_question, vin_detail
         FROM tbl_vinichai
         WHERE ${whereClause}
         LIMIT 50`,
        params
      );
    } catch (_) {
      return [];
    }

    return rows
      .map((row) => {
        const combinedText = [row.vin_key, row.vin_question, row.vin_detail].join(" ");
        return {
          id: row.id,
          source: "tbl_vinichai",
          title: row.vin_question || row.vin_key || "วินิจฉัยที่เกี่ยวข้อง",
          reference: row.vin_key || "tbl_vinichai",
          content: row.vin_detail || "",
          comment: "",
          score: scoreResult(message, combinedText, `${row.vin_key} ${row.vin_question}`),
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  static async searchStructuredLaws(message, target = "all", limit = 5) {
    const pool = getDbPool();
    if (!pool) {
      return [];
    }

    const terms = uniqueTokens(segmentWords(message)).slice(0, 8);
    if (terms.length === 0) {
      return [];
    }

    const queryLawNumber = extractLawNumber(message);
    const inferredScope = target === "all" ? detectLawScope(message) : target;
    const tableConfigs =
      inferredScope === "group"
        ? [
            ["tbl_glaws", "glaw_id", "glaw_number", "glaw_part", "glaw_detail", "glaw_comment", "tbl_glaws"],
          ]
        : inferredScope === "coop"
          ? [
              ["tbl_laws", "law_id", "law_number", "law_part", "law_detail", "law_comment", "tbl_laws"],
            ]
          : [
              ["tbl_laws", "law_id", "law_number", "law_part", "law_detail", "law_comment", "tbl_laws"],
              ["tbl_glaws", "glaw_id", "glaw_number", "glaw_part", "glaw_detail", "glaw_comment", "tbl_glaws"],
            ];

    if (queryLawNumber && isDirectLawNumberQuery(message)) {
      const exactRowGroups = await Promise.all(
        tableConfigs.map((tableConfig) => findExactLawRows(pool, tableConfig, queryLawNumber)),
      );

      const exactRanked = exactRowGroups
        .flat()
        .map((row) => ({
          id: row.id,
          source: row.__sourceName,
          title: row.law_part || row.law_number || "กฎหมายที่เกี่ยวข้อง",
          reference: row.law_number || row.law_part || row.__sourceName,
          content: row.law_detail || "",
          comment: row.law_comment || "",
          score: 999,
        }))
        .filter((row) => extractLawNumber(row.reference || row.title || "") === queryLawNumber);

      if (exactRanked.length > 0) {
        return exactRanked.slice(0, limit);
      }
    }

    const rowGroups = await Promise.all(
      tableConfigs.map(async ([tableName, idField, numberField, partField, detailField, commentField, sourceName]) => {
        const lawNumberPatterns = buildLawNumberPatterns(queryLawNumber);
        const searchTerms = uniqueTokens([...terms, ...lawNumberPatterns]).slice(0, 12);
        const whereClause = searchTerms
          .map(
            () =>
              `(LOWER(${numberField}) LIKE ? OR LOWER(${partField}) LIKE ? OR LOWER(${detailField}) LIKE ? OR LOWER(${commentField}) LIKE ?)`,
          )
          .join(" OR ");
        const params = searchTerms.flatMap((term) => {
          const like = `%${term}%`;
          return [like, like, like, like];
        });

        const [rows] = await pool.query(
          `SELECT ${idField} AS id, ${numberField} AS law_number, ${partField} AS law_part,
                  ${detailField} AS law_detail, ${commentField} AS law_comment
           FROM ${tableName}
           WHERE ${whereClause}
           LIMIT 50`,
          params,
        );

        return rows.map((row) => ({ ...row, __sourceName: sourceName }));
      }),
    );

    const rankedResults = rowGroups
      .flat()
      .map((row) => {
        const combinedText = [
          row.law_number,
          row.law_part,
          row.law_detail,
          row.law_comment,
        ].join(" ");

        let score = scoreResult(message, combinedText, `${row.law_number} ${row.law_part}`);

        if (queryLawNumber && extractLawNumber(row.law_number) === queryLawNumber) {
          score += 90;
        }

        if (queryLawNumber && normalizeForSearch(row.law_number).includes(`มาตรา ${queryLawNumber}`)) {
          score += 50;
        }

        if (
          inferredScope === "coop" &&
          row.__sourceName === "tbl_laws"
        ) {
          score += 40;
        }

        if (
          inferredScope === "group" &&
          row.__sourceName === "tbl_glaws"
        ) {
          score += 40;
        }

        return {
          id: row.id,
          source: row.__sourceName,
          title: row.law_part || row.law_number || "กฎหมายที่เกี่ยวข้อง",
          reference: row.law_number || row.law_part || row.__sourceName,
          content: row.law_detail || "",
          comment: row.law_comment || "",
          score,
        };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);

    if (queryLawNumber && isDirectLawNumberQuery(message)) {
      const exactLawMatches = rankedResults.filter(
        (row) => extractLawNumber(row.reference || row.title || "") === queryLawNumber,
      );

      if (exactLawMatches.length > 0) {
        return exactLawMatches.slice(0, limit);
      }
    }

    return rankedResults.slice(0, limit);
  }
}

module.exports = LawSearchModel;
