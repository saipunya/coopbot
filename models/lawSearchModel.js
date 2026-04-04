const { getDbPool } = require("../config/db");
const {
  extractExplicitTopicHints,
  getQueryFocusProfile,
  hasExclusiveMeaningMismatch,
  makeBigrams,
  normalizeForSearch,
  scoreQueryFocusAlignment,
  segmentWords,
  uniqueTokens,
} = require("../services/thaiTextUtils");

const STRUCTURED_LAW_SEARCH_FIELD_CACHE = new Map();

function extractLawNumber(text) {
  const match = String(text || "").match(/\d+/);
  return match ? match[0] : null;
}

function detectLawScope(text) {
  const normalized = normalizeForSearch(text).toLowerCase();
  const asksCoop = /พรบ|พระราชบัญญัติ|สหกรณ์/.test(normalized);
  const asksGroup = /พรฎ|พระราชกฤษฎีกา|กลุ่มเกษตรกร/.test(normalized);
  const asksLiquidation = /ชำระบัญชี|ผู้ชำระบัญชี/.test(normalized);
  const asksCoopDissolution =
    /(?:การเลิกสหกรณ์|เลิกสหกรณ์|สั่งเลิกสหกรณ์|สหกรณ์(?:ย่อม)?(?:ต้อง)?เลิก)/.test(normalized);

  if (asksCoop && !asksGroup) {
    return "coop";
  }

  if (asksGroup && !asksCoop) {
    return "group";
  }

  if (asksLiquidation) {
    return "coop";
  }

  if (asksCoopDissolution) {
    return "coop";
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

function getFocusedIntentTerms(intent = "general") {
  if (intent === "qualification") {
    return ["คุณสมบัติ", "ลักษณะต้องห้าม", "วิธีการรับสมัคร", "ขาดจากการเป็น", "ไม่มีสิทธิ"];
  }

  if (intent === "duty") {
    return [
      "อำนาจหน้าที่",
      "มีหน้าที่",
      "หน้าที่ของ",
      "หน้าที่ในการ",
      "รายงานเสนอต่อที่ประชุมใหญ่",
      "ทำรายงานเสนอต่อที่ประชุมใหญ่",
      "ตรวจสอบกิจการของสหกรณ์",
    ];
  }

  if (intent === "rights") {
    return [
      "สิทธิ",
      "สิทธิออกเสียง",
      "องค์ประชุม",
      "เป็นกรรมการ",
      "กู้ยืมเงิน",
      "สิทธิและหน้าที่",
      "ถือหุ้นได้",
      "รับเลือกตั้ง",
    ];
  }

  return [];
}

function extractAbbreviationTerms(text) {
  const normalized = normalizeForSearch(String(text || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ""); // เวอร์ชันที่ล้าง . แบบ explicit
  if (!normalized) {
    return [];
  }

  const matches = normalized.match(/\b[ก-๙a-z0-9]{2,8}\b/gi) || [];
  return uniqueTokens(
    matches.filter((term) => term && term.length >= 2 && term.length <= 8),
  );
}


function buildStructuredSearchTerms(message, queryLawNumber = null) {
  const normalizedMessage = normalizeForSearch(message).toLowerCase();
  const explicitTopics = extractExplicitTopicHints(message);
  const lawNumberPatterns = buildLawNumberPatterns(queryLawNumber);
  const abbreviationTerms = extractAbbreviationTerms(message);

  return uniqueTokens([
    normalizedMessage,
    ...segmentWords(message),
    ...explicitTopics,
    ...lawNumberPatterns,
    ...abbreviationTerms,
  ]).filter(Boolean);
}

async function resolveStructuredLawSearchField(pool, tableName) {
  if (!pool || !tableName) {
    return null;
  }

  if (STRUCTURED_LAW_SEARCH_FIELD_CACHE.has(tableName)) {
    return STRUCTURED_LAW_SEARCH_FIELD_CACHE.get(tableName);
  }

  const expectedField = tableName === "tbl_laws" ? "law_search" : tableName === "tbl_glaws" ? "glaw_search" : null;
  if (!expectedField) {
    STRUCTURED_LAW_SEARCH_FIELD_CACHE.set(tableName, null);
    return null;
  }

  try {
    const [rows] = await pool.query(`SHOW COLUMNS FROM ${tableName} LIKE ?`, [expectedField]);
    const resolved = Array.isArray(rows) && rows.length > 0 ? expectedField : null;
    STRUCTURED_LAW_SEARCH_FIELD_CACHE.set(tableName, resolved);
    return resolved;
  } catch (_) {
    STRUCTURED_LAW_SEARCH_FIELD_CACHE.set(tableName, null);
    return null;
  }
}

async function findExactLawRows(pool, tableConfig, queryLawNumber) {
  const [tableName, idField, numberField, partField, detailField, commentField, sourceName, searchField] = tableConfig;
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
            ${detailField} AS law_detail, ${commentField} AS law_comment${
              searchField ? `, ${searchField} AS law_search` : ", NULL AS law_search"
            }
       FROM ${tableName}
      WHERE TRIM(${numberField}) IN (?, ?, ?, ?, ?)
         OR REPLACE(TRIM(${numberField}), ' ', '') IN (?, ?, ?, ?, ?)
      LIMIT 20`,
    [...exactTerms, ...exactTerms.map((term) => term.replace(/\s+/g, ""))],
  );

  return rows.map((row) => ({ ...row, __sourceName: sourceName }));
}

async function findFocusedLawRows(pool, tableConfig, query) {
  const [tableName, idField, numberField, partField, detailField, commentField, sourceName, searchField] = tableConfig;
  const focusProfile = getQueryFocusProfile(query);
  if (!focusProfile.topics.length) {
    return [];
  }

  const topicTerms = uniqueTokens(
    focusProfile.topics.flatMap((topic) => [topic.primary, ...(topic.aliases || [])]).filter(Boolean),
  );
  const topicContextTerms = uniqueTokens(
    focusProfile.topics.flatMap((topic) => topic.contextSignals || []).filter(Boolean),
  );
  const intentTerms = uniqueTokens([
    ...getFocusedIntentTerms(focusProfile.intent),
    ...topicContextTerms,
  ]);
  if (!topicTerms.length) {
    return [];
  }

  const topicClause = topicTerms
    .map(() =>
      searchField
        ? `(LOWER(${partField}) LIKE ? OR LOWER(${detailField}) LIKE ? OR LOWER(${commentField}) LIKE ? OR LOWER(${searchField}) LIKE ?)`
        : `(LOWER(${partField}) LIKE ? OR LOWER(${detailField}) LIKE ? OR LOWER(${commentField}) LIKE ?)`,
    )
    .join(" OR ");
  const topicParams = topicTerms.flatMap((term) => {
    const like = `%${term}%`;
    return searchField ? [like, like, like, like] : [like, like, like];
  });

  const intentClause = intentTerms.length
    ? ` AND (${intentTerms
        .map(() =>
          searchField
            ? `(LOWER(${partField}) LIKE ? OR LOWER(${detailField}) LIKE ? OR LOWER(${commentField}) LIKE ? OR LOWER(${searchField}) LIKE ?)`
            : `(LOWER(${partField}) LIKE ? OR LOWER(${detailField}) LIKE ? OR LOWER(${commentField}) LIKE ?)`,
        )
        .join(" OR ")})`
    : "";
  const intentParams = intentTerms.flatMap((term) => {
    const like = `%${normalizeForSearch(term).toLowerCase()}%`;
    return searchField ? [like, like, like, like] : [like, like, like];
  });

  const [rows] = await pool.query(
    `SELECT ${idField} AS id, ${numberField} AS law_number, ${partField} AS law_part,
            ${detailField} AS law_detail, ${commentField} AS law_comment${
              searchField ? `, ${searchField} AS law_search` : ", NULL AS law_search"
            }
       FROM ${tableName}
      WHERE (${topicClause})${intentClause}
      LIMIT 20`,
    [...topicParams, ...intentParams],
  );

  return rows.map((row) => ({ ...row, __sourceName: sourceName, __focusedMatch: true }));
}

async function findKeywordLawRows(pool, tableConfig, query) {
  const [tableName, idField, numberField, partField, detailField, commentField, sourceName, searchField] = tableConfig;
  if (!searchField) {
    return [];
  }

  const searchTerms = buildStructuredSearchTerms(query).slice(0, 10);
  if (searchTerms.length === 0) {
    return [];
  }

  const whereClause = searchTerms.map(() => `LOWER(${searchField}) LIKE ?`).join(" OR ");
  const params = searchTerms.map((term) => `%${term}%`);
  const exactPhrase = `%${normalizeForSearch(query).toLowerCase()}%`;

  const [rows] = await pool.query(
    `SELECT ${idField} AS id, ${numberField} AS law_number, ${partField} AS law_part,
            ${detailField} AS law_detail, ${commentField} AS law_comment, ${searchField} AS law_search
       FROM ${tableName}
      WHERE ${whereClause}
      ORDER BY CASE WHEN LOWER(${searchField}) LIKE ? THEN 0 ELSE 1 END, ${idField} ASC
      LIMIT 40`,
    [...params, exactPhrase],
  );

  return rows.map((row) => ({ ...row, __sourceName: sourceName, __keywordMatch: true }));
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

  const explicitTopics = extractExplicitTopicHints(query);
  if (
    explicitTopics.length > 0 &&
    explicitTopics.every((topic) => normalizedText.includes(topic))
  ) {
    score += 18;
  }

  const coverage = queryTokens.length > 0 ? tokenHits / queryTokens.length : 0;
  score += coverage * 25;
  score += scoreQueryFocusAlignment(query, `${text} ${primaryLabel || ""}`);

  if (hasExclusiveMeaningMismatch(query, `${text} ${primaryLabel || ""}`)) {
    score -= 120;
  }

  return score;
}

function normalizeComparisonText(text) {
  return normalizeForSearch(String(text || ""))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitVinichaiKeyTerms(vinKey) {
  return uniqueTokens(
    String(vinKey || "")
      .split(/[,\n|/]+/)
      .map((term) => normalizeComparisonText(term))
      .filter(Boolean),
  );
}

function getVinichaiQueryTerms(message) {
  const focusProfile = getQueryFocusProfile(message);
  const topicTerms = focusProfile.topics.flatMap((topic) => [
    topic.primary,
    ...(topic.aliases || []),
    ...(topic.contextSignals || []),
  ]);

  return uniqueTokens(
    [
      ...segmentWords(message),
      ...extractExplicitTopicHints(message),
      ...topicTerms,
    ]
      .map((term) => normalizeComparisonText(term))
      .filter((term) => term && term.length >= 2),
  );
}

function scoreVinichaiKeyMatch(message, vinKey, vinQuestion = "", vinGroup = "") {
  const normalizedMessage = normalizeComparisonText(message);
  if (!normalizedMessage) {
    return 0;
  }

  const keyTerms = splitVinichaiKeyTerms(vinKey);
  if (keyTerms.length === 0) {
    return 0;
  }

  const queryTerms = getVinichaiQueryTerms(message);
  const explicitTopics = extractExplicitTopicHints(message).map((topic) => normalizeComparisonText(topic));
  const normalizedKey = normalizeComparisonText(vinKey);
  const comparisonText = `${normalizeComparisonText(vinQuestion)} ${normalizeComparisonText(vinGroup)}`.trim();
  let score = 0;
  const matchedQueryTerms = new Set();
  let matchedExplicitTopicCount = 0;

  keyTerms.forEach((keyTerm) => {
    if (normalizedMessage.includes(keyTerm)) {
      score += keyTerm.length >= 6 ? 18 : 12;
    }
  });

  queryTerms.forEach((queryTerm) => {
    if (keyTerms.some((keyTerm) => keyTerm === queryTerm)) {
      matchedQueryTerms.add(queryTerm);
      score += queryTerm.length >= 6 ? 14 : 10;
      return;
    }

    if (keyTerms.some((keyTerm) => keyTerm.includes(queryTerm) || queryTerm.includes(keyTerm))) {
      matchedQueryTerms.add(queryTerm);
      score += queryTerm.length >= 6 ? 8 : 5;
    }
  });

  if (queryTerms.length > 0) {
    score += (matchedQueryTerms.size / queryTerms.length) * 32;
  }

  if (matchedQueryTerms.size >= 2) {
    score += 12;
  }

  if (
    explicitTopics.length > 0 &&
    explicitTopics.every((topic) =>
      normalizedKey.includes(topic) ||
      keyTerms.some((keyTerm) => keyTerm.includes(topic) || topic.includes(keyTerm)),
    )
  ) {
    score += 20;
  }

  if (explicitTopics.length > 0) {
    matchedExplicitTopicCount = explicitTopics.filter((topic) =>
      normalizedKey.includes(topic) ||
      keyTerms.some((keyTerm) => keyTerm.includes(topic) || topic.includes(keyTerm)),
    ).length;

    score += matchedExplicitTopicCount * 24;

    if (matchedExplicitTopicCount === 0) {
      score -= 40;
    } else if (matchedExplicitTopicCount < explicitTopics.length) {
      score -= (explicitTopics.length - matchedExplicitTopicCount) * 12;
    }
  }

  if (
    comparisonText &&
    keyTerms.some((keyTerm) => comparisonText.includes(keyTerm)) &&
    /แนววินิจฉัย|วินิจฉัย|ตีความ|ข้อหารือ/.test(normalizedMessage)
  ) {
    score += 6;
  }

  return score;
}

function splitKeywordTerms(keywordText) {
  return uniqueTokens(
    String(keywordText || "")
      .split(/[,\n|/]+/)
      .map((term) => normalizeComparisonText(term))
      .filter(Boolean),
  );
}

function scoreStructuredLawKeywordMatch(message, keywordText = "") {
  const normalizedMessage = normalizeComparisonText(message);
  if (!normalizedMessage || !keywordText) {
    return 0;
  }

  const keywordTerms = splitKeywordTerms(keywordText);
  if (keywordTerms.length === 0) {
    return 0;
  }

  const queryTerms = uniqueTokens(
    [
      ...segmentWords(message),
      ...extractExplicitTopicHints(message),
      ...getQueryFocusProfile(message).topics.flatMap((topic) => [topic.primary, ...(topic.aliases || [])]),
    ]
      .map((term) => normalizeComparisonText(term))
      .filter((term) => term && term.length >= 2),
  );
    const abbreviationTerms = extractAbbreviationTerms(message);

  let score = 0;
    abbreviationTerms.forEach((abbr) => {
    if (keywordTerms.some((keyword) => keyword === abbr)) {
      score += 90;  // เปลี่ยนจาก 60 เป็น 90
      return;
    }

    if (keywordTerms.some((keyword) => keyword.includes(abbr) || abbr.includes(keyword))) {
      score += 45;  // เปลี่ยนจาก 30 เป็น 45
    }
  });
  const matched = new Set();

  keywordTerms.forEach((keyword) => {
    if (normalizedMessage.includes(keyword)) {
      score += keyword.length >= 6 ? 26 : 14;
      matched.add(keyword);
    }

    if (keyword.includes(normalizedMessage)) {
      score += normalizedMessage.length >= 6 ? 36 : 18;
      matched.add(keyword);
    }
  });

  queryTerms.forEach((queryTerm) => {
    if (keywordTerms.some((keyword) => keyword === queryTerm)) {
      score += queryTerm.length >= 6 ? 14 : 8;
      matched.add(queryTerm);
      return;
    }

    if (keywordTerms.some((keyword) => keyword.includes(queryTerm) || queryTerm.includes(keyword))) {
      score += queryTerm.length >= 6 ? 8 : 4;
      matched.add(queryTerm);
    }
  });

  if (queryTerms.length > 0) {
    score += (matched.size / queryTerms.length) * 24;
  }

  return score;
}

class LawSearchModel {
  static async searchVinichai(message, limit = 5) {
    const pool = getDbPool();
    if (!pool) {
      return [];
    }

    const terms = uniqueTokens([
      ...segmentWords(message),
      ...getVinichaiQueryTerms(message),
    ]).slice(0, 10);
    if (terms.length === 0) {
      return [];
    }

    const whereClause = terms
      .map(
        () =>
          `(LOWER(vin_group) LIKE ? OR LOWER(vin_key) LIKE ? OR LOWER(vin_question) LIKE ? OR LOWER(vin_detail) LIKE ? OR LOWER(vin_maihed) LIKE ?)`
      )
      .join(" OR ");
    const params = terms.flatMap((term) => {
      const like = `%${term}%`;
      return [like, like, like, like, like];
    });

    let rows;
    try {
      [rows] = await pool.query(
        `SELECT vin_id, vin_group, vin_key, vin_question, vin_detail, vin_maihed
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
        const combinedText = [
          row.vin_group,
          row.vin_key,
          row.vin_question,
          row.vin_detail,
          row.vin_maihed,
        ].join(" ");
        return {
          id: row.vin_id,
          source: "tbl_vinichai",
          title: row.vin_question || row.vin_key || "วินิจฉัยที่เกี่ยวข้อง",
          reference: row.vin_key || "tbl_vinichai",
          content: row.vin_detail || "",
          comment: row.vin_maihed || "",
          score:
            scoreResult(message, combinedText, `${row.vin_key} ${row.vin_question}`) +
            scoreQueryFocusAlignment(message, combinedText) +
            scoreVinichaiKeyMatch(message, row.vin_key, row.vin_question, row.vin_group),
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

    const queryLawNumber = extractLawNumber(message);
    const terms = buildStructuredSearchTerms(message, queryLawNumber).slice(0, 12);
    if (terms.length === 0) {
      return [];
    }
    const inferredScope = target === "all" ? detectLawScope(message) : target;
    const lawSearchField = await resolveStructuredLawSearchField(pool, "tbl_laws");
    const glawSearchField = await resolveStructuredLawSearchField(pool, "tbl_glaws");
    const tableConfigs =
      inferredScope === "group"
        ? [
            ["tbl_glaws", "glaw_id", "glaw_number", "glaw_part", "glaw_detail", "glaw_comment", "tbl_glaws", glawSearchField],
          ]
        : inferredScope === "coop"
          ? [
              ["tbl_laws", "law_id", "law_number", "law_part", "law_detail", "law_comment", "tbl_laws", lawSearchField],
            ]
          : [
              ["tbl_laws", "law_id", "law_number", "law_part", "law_detail", "law_comment", "tbl_laws", lawSearchField],
              ["tbl_glaws", "glaw_id", "glaw_number", "glaw_part", "glaw_detail", "glaw_comment", "tbl_glaws", glawSearchField],
          ];

    const focusedRowGroups = await Promise.all(
      tableConfigs.map((tableConfig) => findFocusedLawRows(pool, tableConfig, message)),
    );
    const focusedRows = focusedRowGroups.flat();
    const keywordRowGroups = await Promise.all(
      tableConfigs.map((tableConfig) => findKeywordLawRows(pool, tableConfig, message)),
    );
    const keywordRows = keywordRowGroups.flat();
    const focusedResults = focusedRows
      .map((row) => {
        const combinedText = [
          row.law_number,
          row.law_part,
          row.law_detail,
          row.law_comment,
          row.law_search,
        ].join(" ");

        return {
          id: row.id,
          source: row.__sourceName,
          title: row.law_part || row.law_number || "กฎหมายที่เกี่ยวข้อง",
          reference: row.law_number || row.law_part || row.__sourceName,
          content: row.law_detail || "",
          comment: row.law_comment || "",
          score:
            scoreResult(message, combinedText, `${row.law_number} ${row.law_part}`) +
            scoreQueryFocusAlignment(message, combinedText) +
            scoreStructuredLawKeywordMatch(message, row.law_search) +
            80,
        };
      })
      .sort((a, b) => b.score - a.score);

    if (focusedResults.length > 0 && getQueryFocusProfile(message).intent !== "general") {
      return focusedResults.slice(0, limit);
    }

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
      tableConfigs.map(async ([tableName, idField, numberField, partField, detailField, commentField, sourceName, searchField]) => {
        const searchTerms = terms;
        const whereClause = searchTerms
          .map(
            () =>
              searchField
                ? `(LOWER(${numberField}) LIKE ? OR LOWER(${partField}) LIKE ? OR LOWER(${detailField}) LIKE ? OR LOWER(${commentField}) LIKE ? OR LOWER(${searchField}) LIKE ?)`
                : `(LOWER(${numberField}) LIKE ? OR LOWER(${partField}) LIKE ? OR LOWER(${detailField}) LIKE ? OR LOWER(${commentField}) LIKE ?)`,
          )
          .join(" OR ");
        const params = searchTerms.flatMap((term) => {
          const like = `%${term}%`;
          return searchField ? [like, like, like, like, like] : [like, like, like, like];
        });

        const [rows] = await pool.query(
          `SELECT ${idField} AS id, ${numberField} AS law_number, ${partField} AS law_part,
                  ${detailField} AS law_detail, ${commentField} AS law_comment${
                    searchField ? `, ${searchField} AS law_search` : ", NULL AS law_search"
                  }
           FROM ${tableName}
           WHERE ${whereClause}
           LIMIT 50`,
          params,
        );

        return rows.map((row) => ({ ...row, __sourceName: sourceName }));
      }),
    );

    const rankedResults = [...keywordRows, ...focusedRows, ...rowGroups.flat()]
      .map((row) => {
        const combinedText = [
          row.law_number,
          row.law_part,
          row.law_detail,
          row.law_comment,
          row.law_search,
        ].join(" ");

        let score = scoreResult(message, combinedText, `${row.law_number} ${row.law_part}`);
        score += scoreStructuredLawKeywordMatch(message, row.law_search);

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
          score: score + (row.__focusedMatch ? 60 : 0) + (row.__keywordMatch ? 100 : 0),
        };
      })
      .filter((row) => row.score > 0)
      .filter((row, index, list) => {
        const key = `${row.source || ""}::${row.id || ""}`;
        return list.findIndex((item) => `${item.source || ""}::${item.id || ""}` === key) === index;
      })
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
