const { GoogleGenAI } = require("@google/genai");

let client = null;

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
  return sources
    .map((source, index) => {
      return [
        `แหล่งข้อมูลที่ ${index + 1}`,
        `ตาราง: ${source.source || "pdf_chunks"}`,
        `หัวข้อ: ${source.title || "-"}`,
        `อ้างอิง: ${source.reference || "-"}`,
        `เนื้อหา: ${source.content || source.chunk_text || "-"}`,
        `หมายเหตุ: ${source.comment || "-"}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatReferenceLine(source) {
  const tableName = source.source || "pdf_chunks";
  const reference = source.reference || source.title || "ไม่ระบุอ้างอิง";
  return `  - ${tableName}: ${reference}`;
}

function buildReferenceSection(sources) {
  const topSources = sources.slice(0, 3);
  return ["- แหล่งอ้างอิง", ...topSources.map(formatReferenceLine)].join("\n");
}

function cleanLine(text) {
  return String(text || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[*-]\s*/, "")
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

function normalizeModelSummary(text, explainMode, sources) {
  const raw = String(text || "").trim();

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

    return [
      "- สรุปใจความสำคัญ",
      ...fallbackSummary.map((line) => `  - ${line}`),
      "- คำอธิบายเพิ่มเติม",
      ...fallbackDetail.map((line) => `  - ${line}`),
    ].join("\n");
  }

  const conciseLines = uniqueCleanLines(lines, 3);

  if (conciseLines.length === 0) {
    return "";
  }

  return [
    "- สรุปใจความสำคัญ",
    ...conciseLines.map((line) => `  - ${line}`),
  ].join("\n");
}

function buildFallbackSummary(sources, explainMode) {
  const topSources = sources.slice(0, 3);
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
    return "ไม่พบข้อมูลที่เกี่ยวข้องชัดเจน กรุณาระบุคำค้นให้เฉพาะเจาะจงขึ้น";
  }

  return [
    "- สรุปใจความสำคัญ",
    ...importantPoints,
    ...(explainMode
      ? [
          "- คำอธิบายเพิ่มเติม",
          ...(detailPoints.length
            ? detailPoints.map((line) => `  - ${line}`)
            : ["  - หากต้องการรายละเอียดเพิ่ม สามารถพิมพ์คำว่า อธิบาย แล้วตามด้วยประเด็นที่ต้องการได้"]),
        ]
      : []),
    ...buildReferenceSection(topSources).split("\n"),
  ]
    .filter(Boolean)
    .join("\n");
}

async function generateChatSummary(message, sources) {
  const explainMode = wantsExplanation(message);
  const gemini = getGeminiClient();

  if (!gemini || sources.length === 0) {
    return buildFallbackSummary(sources, explainMode);
  }

  const instruction = explainMode
    ? "สรุปคำตอบจากข้อมูลกฎหมายที่ให้มาเป็นภาษาไทยแบบชัดเจน กระชับ และตรงประเด็น ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ให้ตอบเป็น plain text เท่านั้น ห้ามใช้ markdown heading ห้ามขึ้นต้นด้วยคำเกริ่น เช่น สรุปคำตอบดังนี้ ให้มีเพียง 2 section คือ - สรุปใจความสำคัญ และ - คำอธิบายเพิ่มเติม แต่ละข้อย่อยต้องขึ้นต้นด้วย '  - ' และเน้นอธิบายเฉพาะเมื่อผู้ใช้ขอ"
    : "สรุปคำตอบจากข้อมูลกฎหมายที่ให้มาเป็นภาษาไทยแบบสั้น ชัด และตรงประเด็น ห้ามเดาข้อมูลนอกแหล่งอ้างอิง ให้ตอบเป็น plain text เท่านั้น ห้ามใช้ markdown heading และห้ามเกริ่นนำยาว ให้มีเพียง section เดียวคือ - สรุปใจความสำคัญ และแต่ละข้อย่อยต้องขึ้นต้นด้วย '  - '";

  try {
    const response = await gemini.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: `คำถามผู้ใช้: ${message}\n\nข้อมูลอ้างอิง:\n${buildSourceContext(sources)}`,
      config: {
        systemInstruction: instruction,
      },
    });

    const normalized = normalizeModelSummary(String(response.text || "").trim(), explainMode, sources);
    if (!normalized) {
      return buildFallbackSummary(sources, explainMode);
    }
    return [normalized, buildReferenceSection(sources)].join("\n");
  } catch (error) {
    return buildFallbackSummary(sources, explainMode);
  }
}

module.exports = {
  generateChatSummary,
  wantsExplanation,
};
