const { getOpenAiConfig, generateOpenAiCompletion, getOpenAiClient } = require("./openAiService");
const { isAiEnabled } = require("./runtimeSettingsService");
const { normalizeForSearch, segmentWords, uniqueTokens } = require("./thaiTextUtils");

const SOURCE_LABELS = {
  tbl_laws: "พรบ.สหกรณ์ พ.ศ. 2542",
  tbl_glaws: "พรฎ.กลุ่มเกษตรกร พ.ศ. 2547",
  tbl_vinichai: "หนังสือวินิจฉัย/ตีความ",
  pdf_chunks: "เอกสารที่อัปโหลด",
  documents: "ทะเบียนเอกสาร",
  internet_search: "ข้อมูลจากอินเทอร์เน็ต",
  knowledge_base: "ฐานความรู้ภายในระบบ",
  admin_knowledge: "ฐานความรู้ที่ผู้ดูแลระบบเพิ่ม/แก้ไข",
};
const STRUCTURED_LAW_SOURCES = new Set(["tbl_laws", "tbl_glaws"]);
const DATABASE_ONLY_SOURCE_ORDER = [
  "admin_knowledge",
  "tbl_laws",
  "tbl_glaws",
  "pdf_chunks",
  "tbl_vinichai",
  "documents",
  "knowledge_base",
];
const GARBLED_TEXT_PATTERN = /[�\uF700-\uF8FF]|[็์ิีุู่้๊๋]{3,}|~็|็~|◊|Ë|‡|∫|≈|¡|¥|å|ì|î|ï|ñ|ó|ô|ö|ù|û|ü/;

function getGeminiClient() {
  return getOpenAiClient();
}

function wantsExplanation(message) {
  const text = String(message || "").trim();
  return /อธิบาย|รายละเอียด|ขยายความ|ยกตัวอย่าง/.test(text);
}

function wantsAmountAnswer(message) {
  const text = String(message || "").trim();
  return /เท่าไร|เท่าไหร่|กี่บาท|กี่เปอร์เซ็นต์|กี่ร้อยละ|อัตรา|จำนวนเงิน|ค่าบำรุง|ชำระ|จ่าย/.test(
    text,
  );
}

function wantsDecisionAnswer(message) {
  const text = String(message || "").trim();
  return /หรือไม่|ได้ไหม|ได้หรือไม่|ควรหรือไม่|ต้อง.*ไหม|ต้อง.*หรือไม่|จำเป็นต้อง.*ไหม|จำเป็นต้อง.*หรือไม่/.test(
    text,
  );
}

function buildSourceContext(sources) {
  return dedupeSources(sources)
    .map((source, index) => {
      return [
        `แหล่งข้อมูลที่ ${index + 1}`,
        `ตาราง: ${SOURCE_LABELS[source.source] || source.source || "เอกสารที่อัปโหลด"}`,
        `หัวข้อ: ${source.title || "-"}`,
        `อ้างอิง: ${source.reference || "-"}`,
        `เลขที่หนังสือ: ${source.documentNumber || "-"}`,
        `วันที่หนังสือ: ${source.documentDateText || "-"}`,
        `หน่วยงาน: ${source.documentSource || "-"}`,
        `เนื้อหา: ${source.content || source.chunk_text || "-"}`,
        `หมายเหตุ: ${source.comment || "-"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatReferenceLine(source) {
  const tableName = SOURCE_LABELS[source.source] || source.source || "เอกสารที่อัปโหลด";
  const parts = [source.reference || source.title || "ไม่ระบุอ้างอิง"];
  if (source.documentNumber && source.documentNumber !== parts[0]) {
    parts.push(`เลขที่ ${source.documentNumber}`);
  }
  if (source.documentDateText) {
    parts.push(`ลงวันที่ ${source.documentDateText}`);
  }
  return `- ${tableName}: ${parts.filter(Boolean).join(" | ")}`;
}

function dedupeSources(sources, limit = sources.length) {
  const seen = new Set();
  const results = [];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    const sourceName = String(source.source || "pdf_chunks").trim().toLowerCase();
    const stableIdentity =
      source.id ||
      source.url ||
      source.document_id ||
      source.documentId ||
      "";
    const reference = cleanLine(source.reference || source.title || source.keyword || "");
    const contentPreview = cleanLine(String(source.content || source.chunk_text || "").slice(0, 120));
    const dedupeKey = stableIdentity
      ? [sourceName, String(stableIdentity)].join("::")
      : [sourceName, reference || contentPreview].join("::");

    if (!reference && !contentPreview) {
      continue;
    }

    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    results.push(source);

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function buildReferenceSection(sources, limit = 5) {
  const topSources = dedupeSources(sources, limit);
  return ["แหล่งอ้างอิง:", ...topSources.map(formatReferenceLine)].join("\n");
}

function cleanLine(text) {
  return String(text || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[*-]\s*/, "")
    .replace(/^สรุป:\s*/i, "")
    .replace(/^สรุปสาระสำคัญ:\s*/i, "")
    .replace(/^อธิบายเพิ่มเติม:\s*/i, "")
    .replace(/^รายละเอียดเพิ่มเติม:\s*/i, "")
    .replace(/^สรุปคำตอบดังนี้:?\s*/i, "")
    .replace(/^คำตอบ(?:สรุป)?ดังนี้:?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isNoisyLine(text) {
  const line = String(text || "").trim();
  if (!line) {
    return true;
  }

  if (GARBLED_TEXT_PATTERN.test(line)) {
    return true;
  }

  // Common OCR/header-footer noise patterns from scanned PDF pages.
  if (
    /^พัก\s*[:|]/.test(line) ||
    /\|\s*ฝ่ายบริหารทั่วไป/.test(line) ||
    /เล่ม\s*\d+.*ราชกิจจานุเบกษา/.test(line)
  ) {
    return true;
  }

  const pipeCount = (line.match(/\|/g) || []).length;
  if (pipeCount >= 2 && !/(มาตรา|ข้อ|วรรค|บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(line)) {
    return true;
  }

  const disallowed = line.replace(/[\u0E00-\u0E7Fa-zA-Z0-9\s.,:%()\-\/]/g, "");
  const ratio = disallowed.length / Math.max(line.length, 1);
  return ratio > 0.22;
}

function isSectionHeading(line) {
  return /^(สรุปใจความสำคัญ|ประเด็นสำคัญ|คำอธิบายเพิ่มเติม|รายละเอียดเพิ่มเติม|อธิบายเพิ่มเติม|แหล่งอ้างอิง)$/.test(
    cleanLine(line),
  );
}

function uniqueCleanLines(lines, limit) {
  const seen = new Set();
  const results = [];

  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (!cleaned || isSectionHeading(cleaned) || isNoisyLine(cleaned)) {
      continue;
    }

    const key = cleaned.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    results.push(cleaned);

    if (results.length >= limit) {
      break;
    }
  }

  return results;
}

function getQueryTokens(message) {
  return uniqueTokens(segmentWords(message)).filter((token) => String(token || "").trim().length >= 2);
}

function scoreLineByQuery(line, message) {
  const tokens = getQueryTokens(message);
  if (!tokens.length) {
    return 0;
  }

  const normalizedLine = normalizeForSearch(line).toLowerCase();
  const lineTokenSet = new Set(uniqueTokens(segmentWords(line)));
  const tokenHits = tokens.filter((token) => lineTokenSet.has(token) || normalizedLine.includes(token)).length;
  const coverage = tokenHits / tokens.length;
  return tokenHits * 2 + coverage * 6;
}

function hasCoreLegalSignal(line) {
  return /(มาตรา|ข้อ|วรรค|ค่าบำรุง|สันนิบาต|ชำระ|จ่าย|ต้อง|ไม่ต้อง|บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(
    String(line || ""),
  );
}

function splitExplainSections(lines) {
  const summary = [];
  const detail = [];
  let current = "summary";

  for (const rawLine of lines) {
    const line = cleanLine(rawLine);
    if (!line) {
      continue;
    }

    if (/^คำอธิบายเพิ่มเติม|^รายละเอียดเพิ่มเติม|^อธิบายเพิ่มเติม/.test(line)) {
      current = "detail";
      continue;
    }

    if (/^สรุปใจความสำคัญ|^ประเด็นสำคัญ/.test(line)) {
      current = "summary";
      continue;
    }

    if (current === "detail") {
      detail.push(line);
    } else {
      summary.push(line);
    }
  }

  return {
    summary: uniqueCleanLines(summary, 6),
    detail: uniqueCleanLines(detail, 6),
  };
}

function normalizeParagraph(text) {
  return String(text || "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinSentences(lines, limit = 5) {
  return uniqueCleanLines(lines, limit)
    .map((line) => line.replace(/[.;]+$/g, "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildSectionLines(lines, limit = 5) {
  return uniqueCleanLines(lines, limit)
    .map((line) => line.replace(/[.;]+$/g, "").trim())
    .filter(Boolean);
}

function buildParagraphSummary(summaryLines, detailLines, explainMode) {
  const summaryItems = buildSectionLines(summaryLines, explainMode ? 6 : 6);
  const detailItems = buildSectionLines(detailLines, explainMode ? 6 : 4);
  const blocks = [];

  if (summaryItems.length) {
    blocks.push(`สรุปสาระสำคัญ:\n${summaryItems.join("\n")}`);
  }

  if (explainMode && detailItems.length) {
    blocks.push(`รายละเอียดเพิ่มเติม:\n${detailItems.join("\n")}`);
  }

  return blocks.join("\n\n").trim();
}

function extractAmountHighlights(sources, limit = 4) {
  const amountPattern =
    /[^\n]{0,80}\d[\d,]*(?:\.\d+)?\s*(?:บาท|ร้อยละ|เปอร์เซ็นต์|%|ต่อปี|ต่อเดือน|ต่อราย|ต่อรายปี)?[^\n]{0,120}/g;
  const scored = [];

  for (const source of dedupeSources(sources, 8)) {
    const rawText = String(
      [source.reference, source.title, source.content, source.chunk_text, source.comment]
        .filter(Boolean)
        .join(" "),
    );
    const matches = rawText.match(amountPattern) || [];

    for (const match of matches) {
      const cleaned = cleanLine(match);
      if (!cleaned) {
        continue;
      }

      let score = 0;
      if (/(ค่าบำรุง|สันนิบาต)/.test(cleaned)) score += 4;
      if (/(บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(cleaned)) score += 4;
      if (/(อัตรา|จำนวนเงิน|ชำระ|จ่าย)/.test(cleaned)) score += 3;
      if (/\d/.test(cleaned)) score += 2;

      scored.push({
        score,
        text: cleaned,
      });
    }
  }

  return uniqueCleanLines(
    scored.sort((a, b) => b.score - a.score).map((item) => item.text),
    limit,
  );
}

function splitContentSegments(text) {
  return String(text || "")
    .split(/[\n\r]+|(?<=\.)\s+|(?<=;)\s+|(?<=:)\s+/)
    .map((segment) => cleanLine(segment))
    .filter(Boolean);
}

function extractQueryLawNumber(message) {
  const match = String(message || "").match(/(?:มาตรา|ข้อ|วรรค|อนุมาตรา)?\s*(\d{1,4})/);
  return match ? match[1] : "";
}

function getSourceDisplayPriority(sourceName, questionIntent = "general") {
  const normalized = String(sourceName || "").trim().toLowerCase();

  if (questionIntent === "law_section") {
    if (STRUCTURED_LAW_SOURCES.has(normalized)) return 100;
    if (normalized === "admin_knowledge") return 70;
    if (normalized === "tbl_vinichai") return 60;
    if (normalized === "documents") return 40;
    if (normalized === "pdf_chunks") return 30;
    if (normalized === "knowledge_base") return 20;
    return 0;
  }

  if (normalized === "admin_knowledge") return 90;
  if (STRUCTURED_LAW_SOURCES.has(normalized)) return 80;
  if (normalized === "tbl_vinichai") return 70;
  if (normalized === "documents") return 60;
  if (normalized === "pdf_chunks") return 50;
  if (normalized === "knowledge_base") return 40;
  if (normalized === "internet_search") return 10;
  return 0;
}

function orderSourcesForDatabaseOnly(sources, options = {}) {
  const sourceLimit = Math.max(1, Number(options.sourceLimit || 8));
  const quotaBySource = {
    admin_knowledge: 3,
    tbl_laws: options.questionIntent === "law_section" ? 4 : 3,
    tbl_glaws: options.questionIntent === "law_section" ? 4 : 3,
    pdf_chunks: options.explainMode ? 4 : 3,
    tbl_vinichai: 2,
    documents: 2,
    knowledge_base: 1,
  };
  const deduped = dedupeSources(sources, sourceLimit * 5);
  const grouped = new Map();

  deduped.forEach((source) => {
    const sourceName = String(source?.source || "").trim().toLowerCase();
    if (!grouped.has(sourceName)) {
      grouped.set(sourceName, []);
    }
    grouped.get(sourceName).push(source);
  });

  grouped.forEach((items, key) => {
    items.sort((left, right) => {
      const scoreDiff = Number(right.score || 0) - Number(left.score || 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return scoreLineByQuery(
        String(right.content || right.chunk_text || right.reference || right.title || ""),
        options.originalMessage || "",
      ) - scoreLineByQuery(
        String(left.content || left.chunk_text || left.reference || left.title || ""),
        options.originalMessage || "",
      );
    });
    grouped.set(key, items);
  });

  const ordered = [];
  const pushSourceItems = (sourceName, limit) => {
    const items = grouped.get(sourceName) || [];
    items.slice(0, Math.max(0, limit)).forEach((item) => ordered.push(item));
    grouped.delete(sourceName);
  };

  DATABASE_ONLY_SOURCE_ORDER.forEach((sourceName) => {
    pushSourceItems(sourceName, quotaBySource[sourceName] || 0);
  });

  const remainder = Array.from(grouped.entries())
    .flatMap(([, items]) => items)
    .sort((left, right) => {
      const priorityDiff =
        getSourceDisplayPriority(right.source, options.questionIntent) -
        getSourceDisplayPriority(left.source, options.questionIntent);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return Number(right.score || 0) - Number(left.score || 0);
    });

  return [...ordered, ...remainder].slice(0, sourceLimit);
}

function scoreSourceSegment(segment, message, source, options = {}) {
  let score = scoreLineByQuery(segment, message);

  if (hasCoreLegalSignal(segment)) score += 6;
  if (/(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(segment)) score += 5;
  if (STRUCTURED_LAW_SOURCES.has(String(source?.source || "").trim().toLowerCase())) score += 4;
  if (String(source?.source || "").trim().toLowerCase() === "admin_knowledge") score += 3;

  const queryLawNumber = extractQueryLawNumber(message);
  if (queryLawNumber && segment.includes(queryLawNumber)) {
    score += 8;
  }

  if (options.questionIntent === "law_section") {
    if (STRUCTURED_LAW_SOURCES.has(String(source?.source || "").trim().toLowerCase())) {
      score += 12;
    }
    if (score < 2 && !/(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(segment)) {
      score -= 12;
    }
  }

  if (segment.length > 420) {
    score -= 2;
  }

  return score;
}

function extractRelevantSegmentsFromSource(source, message, options = {}) {
  const rawText = [source.content, source.chunk_text, source.comment].filter(Boolean).join("\n");
  const segments = splitContentSegments(rawText);
  const scoredSegments = segments
    .map((segment) => ({
      text: segment,
      score: scoreSourceSegment(segment, message, source, options),
    }))
    .filter((item) => !isNoisyLine(item.text))
    .filter((item) => item.text.length >= 12)
    .filter((item) => {
      if (options.questionIntent === "law_section") {
        return item.score >= 4 || /(มาตรา|ข้อ|วรรค|อนุมาตรา)/.test(item.text);
      }
      return item.score >= 2 || hasCoreLegalSignal(item.text);
    })
    .sort((left, right) => right.score - left.score)
    .map((item) => item.text);

  const segmentLimit =
    options.questionIntent === "law_section"
      ? 6
      : options.explainMode
        ? 5
        : 4;
  const uniqueSegments = uniqueCleanLines(scoredSegments, segmentLimit);

  if (uniqueSegments.length > 0) {
    return uniqueSegments;
  }

  const fallbackText = cleanLine(String(rawText || "").slice(0, options.explainMode ? 420 : 280));
  if (fallbackText && !isNoisyLine(fallbackText)) {
    return [fallbackText];
  }

  return [];
}

function formatDatabaseOnlySourceBlock(source, message, options = {}) {
  const label = SOURCE_LABELS[source.source] || source.source || "ฐานข้อมูลภายในระบบ";
  const reference = cleanLine(source.reference || source.title || source.keyword || label);
  const title = cleanLine(source.title || "");
  const heading = reference && title && title !== reference ? `${reference} | ${title}` : reference || title || label;
  const metaParts = [];

  if (source.documentNumber && source.documentNumber !== reference) {
    metaParts.push(`เลขที่ ${source.documentNumber}`);
  }
  if (source.documentDateText) {
    metaParts.push(`ลงวันที่ ${source.documentDateText}`);
  }
  if (source.documentSource) {
    metaParts.push(source.documentSource);
  }

  const segments = extractRelevantSegmentsFromSource(source, message, options);
  if (segments.length === 0) {
    return "";
  }

  return [
    `[${label}] ${heading}`,
    ...(metaParts.length ? [metaParts.join(" | ")] : []),
    ...segments.map((segment) => `- ${segment}`),
  ].join("\n");
}

function buildDatabaseOnlyAnswer(sources, options = {}) {
  const orderedSources = orderSourcesForDatabaseOnly(sources, {
    questionIntent: options.questionIntent,
    explainMode: options.explainMode,
    originalMessage: options.originalMessage || "",
    sourceLimit: options.questionIntent === "law_section" ? 12 : options.explainMode ? 14 : 12,
  });
  const displayedSources = [];
  const sourceBlocks = orderedSources
    .map((source) => {
      const block = formatDatabaseOnlySourceBlock(source, options.originalMessage || "", {
        explainMode: options.explainMode,
        questionIntent: options.questionIntent,
      });
      if (block) {
        displayedSources.push(source);
      }
      return block;
    })
    .filter(Boolean);

  if (sourceBlocks.length === 0) {
    return "ไม่ปรากฏข้อมูลที่เกี่ยวข้องอย่างชัดเจนในฐานข้อมูล กรุณาระบุคำค้นหรือประเด็นที่ต้องการสอบถามเพิ่มเติม";
  }

  const intro =
    options.questionIntent === "law_section"
      ? "ข้อมูลที่พบจากฐานข้อมูลกฎหมาย (แสดงเฉพาะรายการที่ผ่านการกรองและใช้ตอบ):"
      : "ข้อมูลที่พบจากฐานข้อมูล (แสดงเฉพาะรายการที่ผ่านการกรองและใช้ตอบ):";

  return [intro, ...sourceBlocks, buildReferenceSection(displayedSources, displayedSources.length)]
    .filter(Boolean)
    .join("\n\n");
}

function extractNumericEvidence(sources, limit = 5) {
  const scored = [];

  for (const source of dedupeSources(sources, 10)) {
    const sourceLabel = cleanLine(source.reference || source.title || source.keyword || "");
    const segments = splitContentSegments(
      [source.content, source.chunk_text, source.comment].filter(Boolean).join("\n"),
    );

    for (const segment of segments) {
      if (!/\d/.test(segment)) {
        continue;
      }

      let score = 0;
      if (/(บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(segment)) score += 8;
      if (/(อัตรา|จำนวนเงิน|ค่าบำรุง|ชำระ|จ่าย|เรียกเก็บ)/.test(segment)) score += 7;
      if (/\d[\d,]*(?:\.\d+)?\s*(บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(segment)) score += 12;
      if (source.source === "pdf_chunks") score += 4;
      if (sourceLabel && segment.length < 240) score += 2;

      scored.push({
        score,
        text: sourceLabel ? `${sourceLabel}: ${segment}` : segment,
      });
    }
  }

  return uniqueCleanLines(
    scored.sort((a, b) => b.score - a.score).map((item) => item.text),
    limit,
  );
}

function extractSubstantiveSegments(sources, limit = 5, options = {}) {
  const scored = [];
  const message = String(options.message || "").trim();
  const requireFocus = options.requireFocus === true;

  for (const source of dedupeSources(sources, 10)) {
    const sourceLabel = cleanLine(source.reference || source.title || source.keyword || "");
    const joined = [source.content, source.chunk_text, source.comment].filter(Boolean).join("\n");
    const segments = splitContentSegments(joined);

    for (const segment of segments) {
      if (segment.length < 18 || isNoisyLine(segment)) {
        continue;
      }

      let score = 0;
      const queryScore = scoreLineByQuery(segment, message);
      if (source.source === "admin_knowledge") score += 10;
      if (/ต้อง|ไม่ต้อง|ให้.*ชำระ|ให้.*จ่าย|มีหน้าที่|ต้องชำระ|ต้องจ่าย|จำเป็นต้อง/.test(segment)) score += 8;
      if (/ค่าบำรุง|สันนิบาต/.test(segment)) score += 7;
      if (/บาท|ร้อยละ|เปอร์เซ็นต์|%/.test(segment)) score += 5;
      if (sourceLabel) score += 2;
      score += queryScore;

      if (requireFocus && source.source !== "admin_knowledge") {
        if (queryScore < 2 && !hasCoreLegalSignal(segment)) {
          continue;
        }
      }

      scored.push({
        score,
        text: sourceLabel ? `${sourceLabel}: ${segment}` : segment,
      });
    }
  }

  return uniqueCleanLines(
    scored.sort((a, b) => b.score - a.score).map((item) => item.text),
    limit,
  );
}

function inferDecisionLead(message, sources) {
  if (!wantsDecisionAnswer(message)) {
    return "";
  }

  const segments = extractSubstantiveSegments(sources, 4, { message, requireFocus: true });
  const decisive = segments.find((line) => /ไม่ต้อง|ไม่จำเป็นต้อง|ได้รับยกเว้น/.test(line));
  if (decisive) {
    return decisive;
  }

  const affirmative = segments.find((line) => /ต้อง|ให้.*ชำระ|ให้.*จ่าย|มีหน้าที่.*ชำระ|มีหน้าที่.*จ่าย|ต้องชำระ|ต้องจ่าย/.test(line));
  if (affirmative) {
    return affirmative;
  }

  if (segments[0]) {
    return segments[0];
  }

  return "ยังไม่พบข้อความยืนยันที่ชัดเจนว่า ต้องหรือไม่ต้อง ตามแหล่งข้อมูลที่มีอยู่";
}

function decorateConversationalAnswer(answerText, options = {}) {
  const text = String(answerText || "").trim();
  if (!text) {
    return text;
  }

  if (!options.conversationalFollowUp) {
    return text;
  }

  const topicLabel = cleanLine(options.topicLabel || "");
  const intro = topicLabel ? `ในกรณี${topicLabel} ` : "ในกรณีนี้ ";

  return text
    .replace(/^สรุปสาระสำคัญ:\s*/i, `สรุปสาระสำคัญ:\n${intro}`)
    .replace(/\n\nรายละเอียดเพิ่มเติม:\s*/i, "\n\nรายละเอียดเพิ่มเติม: ")
    .trim();
}

function normalizeModelSummary(text, explainMode, sources, options = {}) {
  const raw = normalizeParagraph(text);

  if (!raw) {
    return "";
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (explainMode) {
    const { summary, detail } = splitExplainSections(lines);
    const fallbackSummary = summary.length
      ? summary
      : uniqueCleanLines(
          sources.map((source) => source.reference || source.title || source.keyword),
          4,
        );
    const fallbackDetail = detail.length
      ? detail
      : uniqueCleanLines(
          sources.map((source) => String(source.content || source.chunk_text || "").slice(0, 220)),
          3,
        );

    return decorateConversationalAnswer(
      buildParagraphSummary(fallbackSummary, fallbackDetail, true),
      options,
    );
  }

  const conciseLines = uniqueCleanLines(lines, 7);

  if (conciseLines.length === 0) {
    return "";
  }

  if (options.amountMode) {
    const amountHighlights = extractAmountHighlights(sources, 3);
    const numericEvidence = extractNumericEvidence(sources, 3);
    const hasNumericLine = conciseLines.some((line) =>
      /\d[\d,]*(?:\.\d+)?\s*(?:บาท|ร้อยละ|เปอร์เซ็นต์|%)/.test(line),
    );
    const mergedLines = hasNumericLine
      ? conciseLines
      : uniqueCleanLines([...numericEvidence, ...amountHighlights, ...conciseLines], 7);

    return decorateConversationalAnswer(buildParagraphSummary(mergedLines, [], false), options);
  }

  if (options.decisionMode) {
    const decisionLead = inferDecisionLead(options.originalMessage || "", sources);
    const decisionSupport = extractSubstantiveSegments(sources, 2, {
      message: options.originalMessage || "",
      requireFocus: true,
    });
    const hasDecisionLine = conciseLines.some((line) =>
      /ไม่ต้อง|ต้อง|ได้|ไม่ได้|ควร|ไม่ควร|จำเป็นต้อง|ไม่จำเป็นต้อง/.test(line),
    );
    const mergedLines = hasDecisionLine
      ? conciseLines
      : uniqueCleanLines([decisionLead, ...decisionSupport, ...conciseLines], 7);

    return decorateConversationalAnswer(buildParagraphSummary(mergedLines, [], false), options);
  }

  return decorateConversationalAnswer(buildParagraphSummary(conciseLines, [], false), options);
}

function buildFallbackSummary(sources, explainMode, options = {}) {
  if (options.databaseOnlyMode) {
    return buildDatabaseOnlyAnswer(sources, {
      ...options,
      explainMode,
    });
  }

  const topSources = dedupeSources(sources, 5);
  const amountHighlights = options.amountMode ? extractAmountHighlights(topSources, explainMode ? 5 : 3) : [];
  const numericEvidence = options.amountMode ? extractNumericEvidence(topSources, explainMode ? 5 : 3) : [];
  const decisionLead = options.decisionMode ? inferDecisionLead(options.originalMessage || "", topSources) : "";
  const substantiveSegments = options.decisionMode
    ? extractSubstantiveSegments(topSources, explainMode ? 5 : 3, {
        message: options.originalMessage || "",
      })
    : [];
  const importantPoints = uniqueCleanLines(
    [
      decisionLead,
      ...substantiveSegments,
      ...numericEvidence,
      ...amountHighlights,
      ...topSources.map((source) => {
        const label = source.reference || source.title || source.keyword || "ข้อมูลที่เกี่ยวข้อง";
        const content = String(source.content || source.chunk_text || "").slice(0, explainMode ? 420 : 180);
        return `${label}: ${content}`;
      }),
    ],
    explainMode ? 8 : 5,
  );
  const detailPoints = uniqueCleanLines(
    [
      ...numericEvidence,
      ...topSources.map((source) =>
        String(source.comment || source.content || source.chunk_text || "").slice(0, explainMode ? 420 : 260),
      ),
    ],
    explainMode ? 6 : 4,
  );

  if (topSources.length === 0) {
    return "ไม่ปรากฏข้อมูลที่เกี่ยวข้องอย่างชัดเจน กรุณาระบุคำค้นหรือประเด็นที่ต้องการสอบถามเพิ่มเติม";
  }

  const answerText = buildParagraphSummary(
    importantPoints,
    detailPoints.length
      ? detailPoints
      : ["หากต้องการรายละเอียดเพิ่ม สามารถพิมพ์คำว่า อธิบาย แล้วตามด้วยประเด็นที่ต้องการได้"],
    explainMode,
  );

  return [decorateConversationalAnswer(answerText, options), buildReferenceSection(topSources)]
    .filter(Boolean)
    .join("\n\n");
}

function filterHighQualitySources(sources, topScore, limit = 4) {
  // Filter out sources with garbled OCR text or very low scores
  // Use stricter threshold: 70% of top score to focus on most relevant sources
  const minScore = Math.max(topScore * 0.7, 80);
  const garbledPattern = /[็์ิีุู่้๊๋]{3,}|~็|็~|◊|Ë|‡|∫|≈|¡|¥|å|ì|î|ï|ñ|ó|ô|ö|ù|û|ü/g;
  
  const filtered = sources.filter((source) => {
    if ((source.score || 0) < minScore) {
      return false;
    }
    
    const content = String(source.content || source.chunk_text || source.preview || "");
    const garbledHits = (content.match(garbledPattern) || []).length;
    if (garbledHits > 2) {
      return false;
    }
    
    return true;
  });
  
  // Limit effective sources by prompt profile to keep AI focused and cost-controlled.
  return filtered.slice(0, Math.max(1, Number(limit || 4)));
}

async function generateChatSummary(message, sources, options = {}) {
  const explainMode = wantsExplanation(message);
  const amountMode = wantsAmountAnswer(message);
  const decisionMode = wantsDecisionAnswer(message);
  const openAiConfig = getOpenAiConfig();
  const aiEnabled = await isAiEnabled();
  const promptProfile = options.promptProfile || {
    code: explainMode ? "detailed" : "brief",
    instructionTone: "",
    summaryRange: explainMode ? "5 ถึง 8 ข้อ" : "4 ถึง 6 ข้อ",
    detailRange: explainMode ? "4 ถึง 8 ข้อ" : "3 ถึง 5 ข้อ",
    aiSourceLimit: explainMode ? 5 : 4,
    compareSources: false,
  };
  const aiSourceLimit = Math.max(1, Number(promptProfile.aiSourceLimit || (explainMode ? 5 : 4)));
  const databaseOnlyMode = Boolean(options.databaseOnlyMode) || !aiEnabled || !openAiConfig;

  // Filter out low-quality sources before sending to Gemini
  const topScore = sources.length > 0 ? Math.max(...sources.map((s) => s.score || 0)) : 0;
  const filteredSources = filterHighQualitySources(sources, topScore, aiSourceLimit);
  const effectiveSources = filteredSources.length > 0 ? filteredSources : sources.slice(0, aiSourceLimit);

  if (options.forceFallback || databaseOnlyMode || effectiveSources.length === 0) {
    return buildFallbackSummary(sources, explainMode, {
      ...options,
      amountMode,
      decisionMode,
      databaseOnlyMode,
      originalMessage: message,
    });
  }

  const amountInstruction = amountMode
    ? "หากข้อมูลอ้างอิงมีจำนวนเงิน อัตรา ร้อยละ เปอร์เซ็นต์ หรือยอดที่ต้องชำระ ให้ระบุค่านั้นอย่างชัดเจนเป็นข้อแรกของ 'สรุปสาระสำคัญ:' พร้อมถ้อยคำที่บอกว่าเป็นจำนวนหรืออัตราเท่าใด และห้ามตอบกว้าง ๆ เฉพาะชื่อแหล่งที่มาโดยไม่บอกตัวเลข"
    : "";
  const continuationInstruction =
    explainMode && options.conversationalFollowUp
      ? "คำถามนี้เป็นการขออธิบายเพิ่มเติมจากเรื่องก่อนหน้า ให้ดึงข้อมูลที่เกี่ยวข้องกับเรื่องเดิมมาอธิบายให้ครบที่สุดก่อน หากข้อมูลมากให้สรุปอย่างกระชับแต่ต้องคงข้อเท็จจริง เงื่อนไข ขั้นตอน ข้อยกเว้น ตัวเลข และข้อความสำคัญที่จำเป็นไว้"
      : "";
  const planToneInstruction = promptProfile.instructionTone
    ? `${promptProfile.instructionTone} `
    : "";
  const compareInstruction = promptProfile.compareSources
    ? "หากมีข้อมูลจากหลายแหล่ง ให้เปรียบเทียบประเด็นที่สอดคล้องหรือแตกต่างกันอย่างกระชับ โดยไม่แต่งข้อมูลนอกแหล่งอ้างอิง "
    : "";
  const depthInstruction =
    promptProfile.code === "brief"
      ? "ให้ตัดรายละเอียดรองที่ไม่จำเป็นออก และเน้นเฉพาะข้อสรุปที่ผู้ใช้ต้องรู้ก่อน "
      : promptProfile.code === "deep"
        ? "ให้คงรายละเอียดสำคัญ เงื่อนไข ข้อยกเว้น และลำดับเหตุผลมากกว่าปกติ "
        : "ให้คงรายละเอียดที่จำเป็นต่อการตัดสินใจหรือความเข้าใจประเด็น ";
  const decisionInstruction = decisionMode
    ? "หากคำถามมีลักษณะถามว่า ต้องหรือไม่ ได้หรือไม่ หรือควรหรือไม่ ให้ตอบข้อแรกอย่างชัดเจนว่า ต้อง ไม่ต้อง ได้ ไม่ได้ ควร หรือไม่ควร ตามข้อมูลที่ปรากฏก่อน แล้วจึงอธิบายเหตุผลหรือเงื่อนไขที่เกี่ยวข้อง ห้ามตอบอ้อมหรือสรุปเฉพาะชื่อมาตราโดยไม่ตอบผลลัพธ์"
    : "";
  const instruction = explainMode
    ? `อ่านและพิจารณาข้อมูลจากทุกแหล่งที่ให้มาครบถ้วน แล้วอธิบายจากข้อมูลที่มีอยู่ให้มากที่สุดก่อน โดยไม่ตัดสาระสำคัญทิ้ง ${planToneInstruction}${depthInstruction}${compareInstruction}${continuationInstruction} ใช้ภาษาไทยสุภาพแบบราชการ ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ${amountInstruction} ${decisionInstruction} ให้ตอบเป็น plain text เท่านั้น โดยขึ้นต้นด้วย 'สรุปสาระสำคัญ:' แล้วตามด้วยข้อความสั้น ๆ แยกคนละบรรทัดประมาณ ${promptProfile.summaryRange || "5 ถึง 8 ข้อ"} และย่อหน้าถัดไปขึ้นต้นด้วย 'รายละเอียดเพิ่มเติม:' แล้วตามด้วยข้อความสั้น ๆ แยกคนละบรรทัดประมาณ ${promptProfile.detailRange || "4 ถึง 8 ข้อ"} ห้ามใช้ markdown heading หากเป็นคำถามต่อเนื่อง ให้ตอบเสมือนเป็นบทสนทนาในเรื่องเดิมต่อเนื่องกัน โดยยังคงถ้อยคำทางราชการ และหลีกเลี่ยงคำลงท้ายแบบภาษาพูด`
    : `อ่านและพิจารณาข้อมูลจากทุกแหล่งที่ให้มาครบถ้วน แล้วสรุปรวมกันเป็นคำตอบภาษาไทยที่ตรงประเด็น ${planToneInstruction}${depthInstruction}${compareInstruction}พร้อมใช้ภาษาราชการที่สุภาพ ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ${amountInstruction} ${decisionInstruction} ให้ตอบเป็น plain text เท่านั้น โดยขึ้นต้นด้วย 'สรุปสาระสำคัญ:' แล้วตามด้วยข้อความสั้น ๆ แยกคนละบรรทัดประมาณ ${promptProfile.summaryRange || "4 ถึง 6 ข้อ"} ห้ามใช้ markdown heading หากเป็นคำถามต่อเนื่อง ให้ตอบเสมือนเป็นบทสนทนาในเรื่องเดิมต่อเนื่องกัน โดยยังคงถ้อยคำทางราชการ และหลีกเลี่ยงคำลงท้ายแบบภาษาพูด`;

  try {
    const conversationNote = options.conversationalFollowUp
      ? `\nบริบทก่อนหน้า: คำถามนี้เป็นคำถามต่อเนื่องเกี่ยวกับหัวข้อ "${options.topicLabel || "เรื่องเดิม"}"`
      : "";
    const responseText = await generateOpenAiCompletion({
      systemInstruction: instruction,
      contents: `คำถามผู้ใช้: ${message}${conversationNote}\n\nข้อมูลอ้างอิง:\n${buildSourceContext(effectiveSources)}`,
      timeoutMs: options.aiTimeoutMs,
      config: {
        systemInstruction: instruction,
      },
    });

    const normalized = normalizeModelSummary(
      String(responseText || "").trim(),
      explainMode,
      effectiveSources,
      {
        ...options,
        amountMode,
        decisionMode,
        originalMessage: message,
      },
    );
    if (!normalized) {
      return buildFallbackSummary(sources, explainMode, {
        ...options,
        amountMode,
        decisionMode,
        originalMessage: message,
      });
    }
    return [normalized, buildReferenceSection(sources)].join("\n\n");
  } catch (error) {
    return buildFallbackSummary(sources, explainMode, {
      ...options,
      amountMode,
      decisionMode,
      originalMessage: message,
    });
  }
}

module.exports = {
  generateChatSummary,
  wantsExplanation,
  SOURCE_LABELS,
};
