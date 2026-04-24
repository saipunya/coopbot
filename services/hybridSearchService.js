const { getDbPool } = require("../config/db");
const { normalizeThai } = require("../utils/thaiNormalizer");
const { expandSearchConcepts, normalizeForSearch, segmentWords, uniqueTokens } = require("./thaiTextUtils");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");

const DEFAULT_LIMIT = 10;
const CANDIDATE_MULTIPLIER = 8;
const MIN_FAQ_SCORE = 18;
const MIN_KEYWORD_SCORE_BEFORE_SEMANTIC = Number(process.env.HYBRID_SEARCH_SEMANTIC_MIN_SCORE || 70);

let cachedMetadata = null;
let cachedFulltextAvailability = null;

function normalizeQuery(text) {
  return normalizeThai(normalizeForSearch(text))
    .replace(/\s+/g, " ")
    .trim();
}

function buildTerms(query) {
  const normalizedQuery = normalizeQuery(query);
  const expandedQuery = normalizeQuery(expandSearchConcepts(query));
  const segmentedTokens = uniqueTokens([
    ...segmentWords(normalizedQuery),
    ...segmentWords(expandedQuery),
  ]);
  const rawTokens = `${normalizedQuery} ${expandedQuery}`.split(/\s+/).filter(Boolean);

  return uniqueTokens([normalizedQuery, expandedQuery, ...segmentedTokens, ...rawTokens])
    .filter((token) => token && token.length >= 2)
    .slice(0, 12);
}

function buildBooleanFulltextQuery(terms) {
  return terms
    .flatMap((term) => String(term || "").split(/\s+/))
    .map((term) => term.replace(/[+\-<>()~*"@]/g, "").trim())
    .filter((term) => term.length >= 2)
    .map((term) => `+${term}*`)
    .join(" ");
}

function escapeLike(value) {
  return String(value || "").replace(/[\\%_]/g, "\\$&");
}

async function resolveMetadata(pool) {
  if (cachedMetadata) {
    return cachedMetadata;
  }

  const [rows] = await pool.query("SHOW COLUMNS FROM pdf_chunks");
  const fields = new Set(rows.map((row) => String(row.Field || "").trim().toLowerCase()));

  cachedMetadata = {
    hasChunkType: fields.has("chunk_type"),
    hasTitle: fields.has("title"),
    hasQuestion: fields.has("question"),
    hasAnswer: fields.has("answer"),
    hasNoteValue: fields.has("note_value"),
    hasStepNo: fields.has("step_no"),
    hasDetail: fields.has("detail"),
    hasReferenceNote: fields.has("reference_note"),
    hasCleanText: fields.has("clean_text"),
    hasSourceFileName: fields.has("source_file_name"),
  };

  return cachedMetadata;
}

async function hasHybridFulltextIndex(pool) {
  if (cachedFulltextAvailability !== null) {
    return cachedFulltextAvailability;
  }

  const [rows] = await pool.query("SHOW INDEX FROM pdf_chunks WHERE Index_type = 'FULLTEXT'");
  cachedFulltextAvailability = rows.some(
    (row) => String(row.Key_name || "").trim() === "idx_pdf_chunks_hybrid_search",
  );
  return cachedFulltextAvailability;
}

function makeSelect(metadata, hasFulltext) {
  return `
    SELECT
      id,
      keyword,
      chunk_text,
      created_at,
      document_id,
      ${metadata.hasChunkType ? "chunk_type" : "NULL"} AS chunk_type,
      ${metadata.hasTitle ? "title" : "NULL"} AS title,
      ${metadata.hasQuestion ? "question" : "NULL"} AS question,
      ${metadata.hasAnswer ? "answer" : "NULL"} AS answer,
      ${metadata.hasNoteValue ? "note_value" : "NULL"} AS note_value,
      ${metadata.hasStepNo ? "step_no" : "NULL"} AS step_no,
      ${metadata.hasDetail ? "detail" : "NULL"} AS detail,
      ${metadata.hasReferenceNote ? "reference_note" : "NULL"} AS reference_note,
      ${metadata.hasCleanText ? "clean_text" : "NULL"} AS clean_text,
      ${metadata.hasSourceFileName ? "source_file_name" : "NULL"} AS source_file_name,
      ${
        hasFulltext
          ? "MATCH(keyword, title, question, answer, chunk_text, clean_text) AGAINST (? IN BOOLEAN MODE)"
          : "0"
      } AS fulltext_score
    FROM pdf_chunks
  `;
}

function buildCandidateQuery(options) {
  const { metadata, hasFulltext, typeFilter, normalizedQuery, terms, limit } = options;
  const whereParts = [];
  const params = [];
  const selectParams = [];

  const searchableColumns = [
    "keyword",
    metadata.hasTitle ? "title" : null,
    metadata.hasQuestion ? "question" : null,
    metadata.hasAnswer ? "answer" : null,
    "chunk_text",
    metadata.hasCleanText ? "clean_text" : null,
  ].filter(Boolean);

  const phraseLike = `%${escapeLike(normalizedQuery)}%`;
  const likeGroup = searchableColumns.map((column) => `LOWER(COALESCE(${column}, '')) LIKE ?`).join(" OR ");
  if (normalizedQuery) {
    whereParts.push(`(${likeGroup})`);
    searchableColumns.forEach(() => params.push(phraseLike));
  }

  terms
    .filter((term) => term !== normalizedQuery)
    .forEach((term) => {
      const like = `%${escapeLike(term)}%`;
      whereParts.push(`(${searchableColumns.map((column) => `LOWER(COALESCE(${column}, '')) LIKE ?`).join(" OR ")})`);
      searchableColumns.forEach(() => params.push(like));
    });

  if (hasFulltext) {
    const fulltextQuery = buildBooleanFulltextQuery(terms);
    if (fulltextQuery) {
      selectParams.push(fulltextQuery);
      whereParts.push("MATCH(keyword, title, question, answer, chunk_text, clean_text) AGAINST (? IN BOOLEAN MODE)");
      params.push(fulltextQuery);
    } else {
      selectParams.push("");
    }
  }

  const sqlParts = [makeSelect(metadata, hasFulltext)];

  if (whereParts.length > 0) {
    sqlParts.push(`WHERE (${whereParts.join(" OR ")})`);
  } else {
    sqlParts.push("WHERE 1 = 1");
  }

  if (typeFilter.length > 0 && metadata.hasChunkType) {
    sqlParts.push(`AND COALESCE(chunk_type, '') IN (${typeFilter.map(() => "?").join(", ")})`);
    params.push(...typeFilter);
  }

  sqlParts.push("ORDER BY fulltext_score DESC, id DESC");
  sqlParts.push("LIMIT ?");
  params.push(Math.max(limit * CANDIDATE_MULTIPLIER, 30));

  return {
    sql: sqlParts.join("\n"),
    params: [...selectParams, ...params],
  };
}

function countMatches(haystack, terms) {
  return terms.reduce((count, term) => (haystack.includes(term) ? count + 1 : count), 0);
}

function scoreTypeIntent(query, rowType) {
  const normalizedQuery = normalizeQuery(query);
  const normalizedType = String(rowType || "").trim().toLowerCase();

  if (!normalizedType || !normalizedQuery) {
    return 0;
  }

  if (normalizedType === "faq" && /(คำถาม|faq|ถามตอบ)/.test(normalizedQuery)) {
    return 10;
  }

  if (normalizedType === "summary" && /(สรุป|ภาพรวม)/.test(normalizedQuery)) {
    return 8;
  }

  if (normalizedType === "note" && /(บันทึก|ข้อควรจำ|note)/.test(normalizedQuery)) {
    return 8;
  }

  if (normalizedType === "process" && /(ขั้นตอน|กระบวนการ|โครงสร้าง|process)/.test(normalizedQuery)) {
    return 8;
  }

  return 0;
}

function scoreRow(query, row, terms) {
  const normalizedQuery = normalizeQuery(query);
  const keyword = normalizeQuery(row.keyword || "");
  const title = normalizeQuery(row.title || "");
  const question = normalizeQuery(row.question || "");
  const answer = normalizeQuery(row.answer || row.note_value || row.detail || "");
  const chunkText = normalizeQuery(row.chunk_text || "");
  const cleanText = normalizeQuery(row.clean_text || "");
  const chunkType = String(row.chunk_type || "").trim().toLowerCase();

  const debug = {
    faqPriority: chunkType === "faq" ? 18 : 0,
    exactQuestion: question && normalizedQuery && question.includes(normalizedQuery) ? 35 : 0,
    exactTitle: title && normalizedQuery && title.includes(normalizedQuery) ? 18 : 0,
    exactKeyword: keyword && normalizedQuery && keyword.includes(normalizedQuery) ? 14 : 0,
    questionHits: countMatches(question, terms) * 9,
    keywordHits: countMatches(keyword, terms) * 8,
    titleHits: countMatches(title, terms) * 7,
    answerHits: countMatches(answer, terms) * 6,
    chunkHits: countMatches(chunkText, terms) * 5,
    cleanTextHits: countMatches(cleanText, terms) * 4,
    typeIntent: scoreTypeIntent(query, chunkType),
    fulltext: Number(row.fulltext_score || 0) * 10,
  };

  const score = Object.values(debug).reduce(
    (sum, value) => sum + (Number.isFinite(Number(value)) ? Number(value) : 0),
    0,
  );

  return {
    score,
    debug,
  };
}

function mapResult(row, scoring) {
  return {
    id: row.id,
    chunkType: row.chunk_type || null,
    title: row.title || null,
    question: row.question || null,
    answer: row.answer || row.note_value || row.detail || null,
    noteValue: row.note_value || null,
    stepNo: row.step_no || null,
    detail: row.detail || null,
    referenceNote: row.reference_note || null,
    keyword: row.keyword || "",
    chunkText: row.chunk_text || "",
    cleanText: row.clean_text || "",
    sourceFileName: row.source_file_name || null,
    score: Number(scoring.score.toFixed(4)),
    debugScores: scoring.debug,
  };
}

function pickTopAnswerCandidate(results) {
  const best = results.find((item) => item.answer || item.chunkText);
  if (!best) {
    return null;
  }

  return {
    id: best.id,
    chunkType: best.chunkType,
    title: best.title,
    answer: best.answer || best.chunkText,
    score: best.score,
  };
}

function mapSemanticResult(result = {}) {
  return {
    id: result.id,
    chunkType: result.chunkType || null,
    title: result.title || null,
    question: result.question || null,
    answer: result.answer || result.chunk_text || result.chunkText || null,
    noteValue: result.noteValue || null,
    stepNo: result.stepNo || null,
    detail: result.detail || null,
    referenceNote: result.referenceNote || null,
    keyword: result.keyword || "",
    chunkText: result.chunk_text || result.chunkText || "",
    cleanText: result.clean_text || result.cleanText || "",
    sourceFileName: result.sourceFileName || result.originalname || null,
    score: Number(result.score || 0),
    debugScores: {
      semantic: Number(result.similarity || 0),
    },
  };
}

async function fetchAndRank(query, typeFilter, limit) {
  const pool = getDbPool();
  if (!pool) {
    throw new Error("Database connection is unavailable.");
  }

  const metadata = await resolveMetadata(pool);
  const hasFulltext = await hasHybridFulltextIndex(pool);
  const normalizedQuery = normalizeQuery(query);
  const terms = buildTerms(query);
  const { sql, params } = buildCandidateQuery({
    metadata,
    hasFulltext,
    typeFilter,
    normalizedQuery,
    terms,
    limit,
  });
  const [rows] = await pool.query(sql, params);

  return rows
    .map((row) => {
      const scoring = scoreRow(query, row, terms);
      return mapResult(row, scoring);
    })
    .sort((left, right) => right.score - left.score || right.id - left.id);
}

async function searchPdfChunks(query, options = {}) {
  const normalizedQuery = normalizeQuery(query);
  const limit = Math.max(1, Math.min(Number(options.limit || DEFAULT_LIMIT), 10));

  if (!normalizedQuery) {
    const error = new Error("Query is required.");
    error.statusCode = 400;
    throw error;
  }

  const faqResults = await fetchAndRank(query, ["faq"], limit);
  const topFaqScore = faqResults[0] ? Number(faqResults[0].score || 0) : 0;

  let usedFallback = false;
  let mergedResults = faqResults.slice(0, limit);

  if (mergedResults.length === 0 || topFaqScore < MIN_FAQ_SCORE) {
    usedFallback = true;
    const fallbackResults = await fetchAndRank(query, ["note", "process", "summary", ""], limit);
    const seenIds = new Set();
    mergedResults = [...faqResults, ...fallbackResults]
      .filter((item) => {
        if (seenIds.has(item.id)) {
          return false;
        }
        seenIds.add(item.id);
        return true;
      })
      .sort((left, right) => right.score - left.score || right.id - left.id)
      .slice(0, limit);
  }

  const topKeywordScore = Number(mergedResults[0]?.score || 0);
  let usedSemanticFallback = false;

  if (mergedResults.length === 0 || topKeywordScore < MIN_KEYWORD_SCORE_BEFORE_SEMANTIC) {
    const semanticResults = (await LawChatbotPdfChunkModel.semanticSearch(query, limit)).map(mapSemanticResult);
    if (semanticResults.length > 0) {
      usedSemanticFallback = true;
      const seenIds = new Set();
      mergedResults = [...mergedResults, ...semanticResults]
        .filter((item) => {
          if (seenIds.has(item.id)) {
            return false;
          }
          seenIds.add(item.id);
          return true;
        })
        .sort((left, right) => right.score - left.score || right.id - left.id)
        .slice(0, limit);
    }
  }

  return {
    query: String(query || ""),
    normalizedQuery,
    total: mergedResults.length,
    usedFallback,
    usedSemanticFallback,
    expandedQuery: normalizeQuery(expandSearchConcepts(query)),
    results: mergedResults,
    debugScores: mergedResults.map((item) => ({
      id: item.id,
      chunkType: item.chunkType,
      score: item.score,
      debugScores: item.debugScores,
    })),
    topAnswerCandidate: pickTopAnswerCandidate(mergedResults),
  };
}

module.exports = {
  searchPdfChunks,
  normalizeQuery,
};
