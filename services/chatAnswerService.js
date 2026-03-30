const { GoogleGenAI } = require("@google/genai");

let client = null;

const SOURCE_LABELS = {
  tbl_laws: "พรบ.สหกรณ์ พ.ศ. 2542",
  tbl_glaws: "พรฎ.กลุ่มเกษตรกร พ.ศ. 2547",
  pdf_chunks: "เอกสารที่อัปโหลด",
};

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return null;
  }

  if (!client) {
    client = new GoogleGenAI({ apiKey });
  }

  return client;
}

function wantsExplanation(message) {
  const text = String(message || "").trim();
  return /อธิบาย|รายละเอียด|ขยายความ|ยกตัวอย่าง/.test(text);
}

function buildSourceContext(sources) {
  return dedupeSources(sources)
    .map((source, index) => {
      return [
        `แหล่งข้อมูลที่ ${index + 1}`,
        `ตาราง: ${SOURCE_LABELS[source.source] || source.source || "เอกสารที่อัปโหลด"}`,
        `หัวข้อ: ${source.title || "-"}`,
        `อ้างอิง: ${source.reference || "-"}`,
        `เนื้อหา: ${source.content || source.chunk_text || "-"}`,
        `หมายเหตุ: ${source.comment || "-"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatReferenceLine(source) {
  const tableName = SOURCE_LABELS[source.source] || source.source || "เอกสารที่อัปโหลด";
  const reference = source.reference || source.title || "ไม่ระบุอ้างอิง";
  return `- ${tableName}: ${reference}`;
}

function dedupeSources(sources, limit = sources.length) {
  const seen = new Set();
  const results = [];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    const sourceName = String(source.source || "pdf_chunks").trim().toLowerCase();
    const reference = cleanLine(source.reference || source.title || source.keyword || "");
    const contentPreview = cleanLine(String(source.content || source.chunk_text || "").slice(0, 120));
    const dedupeKey = [sourceName, reference || contentPreview].join("::");

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

function buildReferenceSection(sources) {
  const topSources = dedupeSources(sources, 3);
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
    if (!cleaned || isSectionHeading(cleaned)) {
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
    summary: uniqueCleanLines(summary, 3),
    detail: uniqueCleanLines(detail, 3),
  };
}

function normalizeParagraph(text) {
  return String(text || "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function joinSentences(lines) {
  return uniqueCleanLines(lines, 3)
    .map((line) => line.replace(/[.;]+$/g, "").trim())
    .filter(Boolean)
    .join(" ");
}

function buildParagraphSummary(summaryLines, detailLines, explainMode) {
  const summaryText = joinSentences(summaryLines);
  const detailText = joinSentences(detailLines);
  const blocks = [];

  if (summaryText) {
    blocks.push(`สรุปสาระสำคัญ: ${summaryText}`);
  }

  if (explainMode && detailText) {
    blocks.push(`รายละเอียดเพิ่มเติม: ${detailText}`);
  }

  return blocks.join("\n\n").trim();
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
    .replace(/^สรุปสาระสำคัญ:\s*/i, `สรุปสาระสำคัญ: ${intro}`)
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
          3,
        );
    const fallbackDetail = detail.length
      ? detail
      : uniqueCleanLines(
          sources.map((source) => String(source.content || source.chunk_text || "").slice(0, 220)),
          2,
        );

    return decorateConversationalAnswer(
      buildParagraphSummary(fallbackSummary, fallbackDetail, true),
      options,
    );
  }

  const conciseLines = uniqueCleanLines(lines, 3);

  if (conciseLines.length === 0) {
    return "";
  }

  return decorateConversationalAnswer(buildParagraphSummary(conciseLines, [], false), options);
}

function buildFallbackSummary(sources, explainMode, options = {}) {
  const topSources = dedupeSources(sources, 3);
  const importantPoints = uniqueCleanLines(
    topSources.map((source) => {
      const label = source.reference || source.title || source.keyword || "ข้อมูลที่เกี่ยวข้อง";
      const content = String(source.content || source.chunk_text || "").slice(0, explainMode ? 220 : 140);
      return `${label}: ${content}`;
    }),
    explainMode ? 3 : 2,
  );
  const detailPoints = uniqueCleanLines(
    topSources.map((source) => String(source.comment || source.content || source.chunk_text || "").slice(0, 220)),
    2,
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

async function generateChatSummary(message, sources, options = {}) {
  const explainMode = wantsExplanation(message);
  const gemini = getGeminiClient();

  if (!gemini || sources.length === 0) {
    return buildFallbackSummary(sources, explainMode, options);
  }

  const instruction = explainMode
    ? "สรุปคำตอบจากข้อมูลกฎหมายที่ให้มาเป็นภาษาไทยแบบชัดเจน กระชับ ตรงประเด็น และใช้ภาษาราชการที่สุภาพ ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ให้ตอบเป็น plain text เท่านั้น ไม่ต้องทำเป็น bullet หรือ markdown heading โดยย่อหน้าแรกขึ้นต้นด้วย 'สรุปสาระสำคัญ:' และย่อหน้าถัดไปขึ้นต้นด้วย 'รายละเอียดเพิ่มเติม:' หากเป็นคำถามต่อเนื่อง ให้ตอบเสมือนเป็นบทสนทนาในเรื่องเดิมต่อเนื่องกัน โดยยังคงถ้อยคำทางราชการ และหลีกเลี่ยงคำลงท้ายแบบภาษาพูด"
    : "สรุปคำตอบจากข้อมูลกฎหมายที่ให้มาเป็นภาษาไทยแบบสั้น ชัดเจน ตรงประเด็น และใช้ภาษาราชการที่สุภาพ ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ให้ตอบเป็น plain text เท่านั้น ไม่ต้องทำเป็น bullet หรือ markdown heading และให้ขึ้นต้นด้วย 'สรุปสาระสำคัญ:' หากเป็นคำถามต่อเนื่อง ให้ตอบเสมือนเป็นบทสนทนาในเรื่องเดิมต่อเนื่องกัน โดยยังคงถ้อยคำทางราชการ และหลีกเลี่ยงคำลงท้ายแบบภาษาพูด";

  try {
    const conversationNote = options.conversationalFollowUp
      ? `\nบริบทก่อนหน้า: คำถามนี้เป็นคำถามต่อเนื่องเกี่ยวกับหัวข้อ "${options.topicLabel || "เรื่องเดิม"}"`
      : "";
    const response = await gemini.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: `คำถามผู้ใช้: ${message}${conversationNote}\n\nข้อมูลอ้างอิง:\n${buildSourceContext(sources)}`,
      config: {
        systemInstruction: instruction,
      },
    });

    const normalized = normalizeModelSummary(
      String(response.text || "").trim(),
      explainMode,
      sources,
      options,
    );
    if (!normalized) {
      return buildFallbackSummary(sources, explainMode, options);
    }
    return [normalized, buildReferenceSection(sources)].join("\n\n");
  } catch (error) {
    return buildFallbackSummary(sources, explainMode, options);
  }
}

module.exports = {
  generateChatSummary,
  wantsExplanation,
  SOURCE_LABELS,
};
