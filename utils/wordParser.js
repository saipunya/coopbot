const mammoth = require("mammoth");
const { normalizeThai } = require("./thaiNormalizer");
const { normalizeThaiPdfText } = require("../services/thaiPdfTextNormalizer");
const { normalizeForSearch, segmentWords, uniqueTokens } = require("../services/thaiTextUtils");

const SECTION_TITLES = {
  summary: "สรุปภาพรวม",
  faq: "คำถามที่พบบ่อย",
  note: "บันทึกข้อควรจำ",
  process: "รายงานเชิงโครงสร้าง",
};

const TYPE_LABELS = {
  summary: "summary",
  faq: "faq",
  note: "note",
  process: "process",
};

function normalizeText(text) {
  return normalizeThaiPdfText(String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim());
}

function appendText(currentValue, nextValue) {
  const current = String(currentValue || "").trim();
  const next = String(nextValue || "").trim();

  if (!next) {
    return current;
  }

  if (!current) {
    return next;
  }

  return `${current}\n${next}`;
}

function toArabicNumber(value) {
  const thaiDigitMap = {
    "๐": "0",
    "๑": "1",
    "๒": "2",
    "๓": "3",
    "๔": "4",
    "๕": "5",
    "๖": "6",
    "๗": "7",
    "๘": "8",
    "๙": "9",
  };

  return String(value || "")
    .replace(/[๐-๙]/g, (character) => thaiDigitMap[character] || character);
}

function detectSectionKey(line) {
  const normalizedLine = normalizeForSearch(toArabicNumber(line))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (!normalizedLine) {
    return null;
  }

  if (/^1[\s.)-]*สรุปภาพรวม[:：]?$/.test(normalizedLine) || normalizedLine === "สรุปภาพรวม") {
    return "summary";
  }

  if (/^2[\s.)-]*คำถามที่พบบ่อย[:：]?$/.test(normalizedLine) || normalizedLine === "คำถามที่พบบ่อย") {
    return "faq";
  }

  if (/^3[\s.)-]*บันทึกข้อควรจำ[:：]?$/.test(normalizedLine) || normalizedLine === "บันทึกข้อควรจำ") {
    return "note";
  }

  if (
    /^4[\s.)-]*รายงานเชิงโครงสร้าง[:：]?$/.test(normalizedLine) ||
    normalizedLine === "รายงานเชิงโครงสร้าง"
  ) {
    return "process";
  }

  return null;
}

function splitSections(rawText) {
  const lines = normalizeText(rawText).split("\n");
  const sections = {
    summary: [],
    faq: [],
    note: [],
    process: [],
  };

  let currentSection = null;

  lines.forEach((line) => {
    const detectedSection = detectSectionKey(line);
    if (detectedSection) {
      currentSection = detectedSection;
      return;
    }

    if (!currentSection) {
      return;
    }

    sections[currentSection].push(line);
  });

  return Object.fromEntries(
    Object.entries(sections).map(([key, value]) => [key, normalizeText(value.join("\n"))]),
  );
}

function splitParagraphs(text) {
  return normalizeText(text)
    .split(/\n\s*\n/g)
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function truncateTitle(text, maxLength = 255) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.slice(0, maxLength);
}

function buildKeyword(parts = []) {
  const text = normalizeForSearch(parts.filter(Boolean).join(" "));
  const tokens = uniqueTokens(segmentWords(text))
    .filter((token) => token && token.length >= 2)
    .slice(0, 12);

  const fallback = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 255);

  return (tokens.join(" ").trim() || fallback || "docx-import").slice(0, 255);
}

function buildChunkRecord(payload) {
  const originalText = normalizeText(payload.originalText || payload.chunkText || "");
  const chunkText = normalizeText(payload.chunkText || "");
  const title = truncateTitle(payload.title || "");
  const question = normalizeText(payload.question || "");
  const answer = normalizeText(payload.answer || "");
  const noteValue = normalizeText(payload.noteValue || "");
  const detail = normalizeText(payload.detail || "");
  const referenceNote = normalizeText(payload.referenceNote || "");
  const sortOrder = Number(payload.sortOrder || 0);
  const chunkType = String(payload.chunkType || "").trim().toLowerCase();

  return {
    chunkType,
    title,
    question,
    answer,
    noteValue,
    stepNo: Number.isFinite(Number(payload.stepNo)) ? Number(payload.stepNo) : null,
    detail,
    referenceNote,
    originalText,
    chunkText,
    cleanText: normalizeThai(chunkText),
    keyword: buildKeyword([
      chunkType,
      title,
      question,
      answer,
      noteValue,
      detail,
      referenceNote,
      chunkText,
    ]),
    sortOrder,
  };
}

function parseSummarySection(text, startOrder) {
  const paragraphs = splitParagraphs(text);

  return paragraphs.map((paragraph, index) =>
    buildChunkRecord({
      chunkType: TYPE_LABELS.summary,
      title: truncateTitle(paragraph.split("\n")[0] || SECTION_TITLES.summary),
      chunkText: paragraph,
      sortOrder: startOrder + index,
    }),
  );
}

function parseFaqSection(text, startOrder) {
  const normalizedText = normalizeText(text);
  const items = [];
  const faqPattern =
    /(?:^|\n)\s*คำถาม\s*[:：]\s*([\s\S]*?)\n\s*คำตอบ\s*[:：]\s*([\s\S]*?)(?=(?:\n\s*คำถาม\s*[:：])|$)/g;

  let match = faqPattern.exec(normalizedText);
  while (match) {
    const question = normalizeText(match[1]);
    const answer = normalizeText(match[2]);
    if (question && answer) {
      items.push({ question, answer });
    }
    match = faqPattern.exec(normalizedText);
  }

  if (items.length === 0) {
    const lines = normalizedText.split("\n");
    let currentQuestion = "";
    let currentAnswer = "";
    let mode = "";

    const pushCurrent = () => {
      const question = normalizeText(currentQuestion);
      const answer = normalizeText(currentAnswer);
      if (question && answer) {
        items.push({ question, answer });
      }
      currentQuestion = "";
      currentAnswer = "";
      mode = "";
    };

    lines.forEach((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        return;
      }

      const questionMatch = trimmedLine.match(/^คำถาม\s*[:：]\s*(.*)$/);
      if (questionMatch) {
        pushCurrent();
        currentQuestion = questionMatch[1] || "";
        mode = "question";
        return;
      }

      const answerMatch = trimmedLine.match(/^คำตอบ\s*[:：]\s*(.*)$/);
      if (answerMatch) {
        currentAnswer = answerMatch[1] || "";
        mode = "answer";
        return;
      }

      if (mode === "answer") {
        currentAnswer = appendText(currentAnswer, trimmedLine);
      } else if (mode === "question") {
        currentQuestion = appendText(currentQuestion, trimmedLine);
      }
    });

    pushCurrent();
  }

  return items.map((item, index) =>
    buildChunkRecord({
      chunkType: TYPE_LABELS.faq,
      title: item.question,
      question: item.question,
      answer: item.answer,
      chunkText: `คำถาม: ${item.question}\nคำตอบ: ${item.answer}`,
      sortOrder: startOrder + index,
    }),
  );
}

function parseNoteSection(text, startOrder) {
  const paragraphs = splitParagraphs(text);
  const rows = [];

  paragraphs.forEach((paragraph) => {
    const flattened = paragraph.replace(/\n+/g, " ").trim();
    if (!flattened) {
      return;
    }

    const delimiterMatch = flattened.match(/^([^:：]{1,200})\s*[:：]\s*(.+)$/);
    const dashMatch = flattened.match(/^(.{1,120}?)\s+-\s+(.+)$/);
    const title = truncateTitle((delimiterMatch && delimiterMatch[1]) || (dashMatch && dashMatch[1]) || flattened);
    const noteValue = normalizeText((delimiterMatch && delimiterMatch[2]) || (dashMatch && dashMatch[2]) || "");

    rows.push(
      buildChunkRecord({
        chunkType: TYPE_LABELS.note,
        title,
        noteValue,
        chunkText: `${title}${noteValue ? `: ${noteValue}` : ""}`,
        sortOrder: startOrder + rows.length,
      }),
    );
  });

  return rows;
}

function parseStepHeader(line) {
  const match = String(line || "")
    .trim()
    .match(/^(?:(?:ขั้นตอนที่|step)\s*([0-9๐-๙]+)|([0-9๐-๙]+)[.)-])\s*(.*)$/i);

  if (!match) {
    return null;
  }

  const stepNo = Number(toArabicNumber(match[1] || match[2] || ""));
  const title = normalizeText(match[3] || "");

  return {
    stepNo: Number.isFinite(stepNo) ? stepNo : null,
    title,
  };
}

function parseProcessSection(text, startOrder) {
  const lines = normalizeText(text).split("\n");
  const rows = [];
  let currentStep = null;
  let fallbackStepNo = 1;

  const pushCurrent = () => {
    if (!currentStep) {
      return;
    }

    const title = truncateTitle(currentStep.title || `ขั้นตอนที่ ${currentStep.stepNo || fallbackStepNo}`);
    const detail = normalizeText(currentStep.detail || "");
    const referenceNote = normalizeText(currentStep.referenceNote || "");
    const chunkParts = [`ขั้นตอนที่ ${currentStep.stepNo || fallbackStepNo}: ${title}`];
    if (detail) {
      chunkParts.push(`รายละเอียด: ${detail}`);
    }
    if (referenceNote) {
      chunkParts.push(`หมายเหตุอ้างอิง: ${referenceNote}`);
    }

    rows.push(
      buildChunkRecord({
        chunkType: TYPE_LABELS.process,
        title,
        stepNo: currentStep.stepNo || fallbackStepNo,
        detail,
        referenceNote,
        chunkText: chunkParts.join("\n"),
        sortOrder: startOrder + rows.length,
      }),
    );

    currentStep = null;
  };

  lines.forEach((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      return;
    }

    const stepHeader = parseStepHeader(trimmedLine);
    if (stepHeader) {
      pushCurrent();
      currentStep = {
        stepNo: stepHeader.stepNo || fallbackStepNo,
        title: stepHeader.title,
        detail: "",
        referenceNote: "",
      };
      fallbackStepNo = Math.max(fallbackStepNo, (currentStep.stepNo || 0) + 1);
      return;
    }

    if (!currentStep) {
      currentStep = {
        stepNo: fallbackStepNo,
        title: "",
        detail: "",
        referenceNote: "",
      };
      fallbackStepNo += 1;
    }

    const titleMatch = trimmedLine.match(/^หัวข้อ\s*[:：]\s*(.*)$/);
    if (titleMatch) {
      currentStep.title = appendText(currentStep.title, titleMatch[1]);
      return;
    }

    const detailMatch = trimmedLine.match(/^รายละเอียด\s*[:：]\s*(.*)$/);
    if (detailMatch) {
      currentStep.detail = appendText(currentStep.detail, detailMatch[1]);
      return;
    }

    const referenceMatch = trimmedLine.match(/^(?:หมายเหตุอ้างอิง|อ้างอิง|reference_note)\s*[:：]\s*(.*)$/i);
    if (referenceMatch) {
      currentStep.referenceNote = appendText(currentStep.referenceNote, referenceMatch[1]);
      return;
    }

    if (!currentStep.title) {
      currentStep.title = trimmedLine;
      return;
    }

    currentStep.detail = appendText(currentStep.detail, trimmedLine);
  });

  pushCurrent();
  return rows;
}

async function parseDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  const rawText = normalizeText(result.value || "");
  const sections = splitSections(rawText);
  const hasStructuredSections = Object.values(sections).some(Boolean);
  const normalizedSections = hasStructuredSections
    ? sections
    : {
        summary: rawText,
        faq: "",
        note: "",
        process: "",
      };
  const rows = [];

  rows.push(...parseSummarySection(normalizedSections.summary, rows.length + 1));
  rows.push(...parseFaqSection(normalizedSections.faq, rows.length + 1));
  rows.push(...parseNoteSection(normalizedSections.note, rows.length + 1));
  rows.push(...parseProcessSection(normalizedSections.process, rows.length + 1));

  return {
    rawText,
    sections: normalizedSections,
    rows,
    messages: Array.isArray(result.messages)
      ? result.messages.map((item) => ({
          type: item.type || "info",
          message: item.message || "",
        }))
      : [],
    stats: {
      summary: rows.filter((item) => item.chunkType === TYPE_LABELS.summary).length,
      faq: rows.filter((item) => item.chunkType === TYPE_LABELS.faq).length,
      note: rows.filter((item) => item.chunkType === TYPE_LABELS.note).length,
      process: rows.filter((item) => item.chunkType === TYPE_LABELS.process).length,
      total: rows.length,
    },
  };
}

module.exports = {
  SECTION_TITLES,
  parseDocx,
};
