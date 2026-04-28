const { normalizeForSearch } = require("./thaiTextUtils");
const ChatbotSuggestedQuestionModel = require("../models/chatbotSuggestedQuestionModel");

const VALID_DOMAINS = new Set(["legal", "general", "mixed"]);
const VALID_TARGETS = new Set(["all", "coop", "group", "general"]);

function makeImportError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeImportText(value) {
  return normalizeForSearch(String(value || ""))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeImportDomain(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_DOMAINS.has(normalized) ? normalized : "legal";
}

function normalizeImportTarget(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return VALID_TARGETS.has(normalized) ? normalized : "all";
}

function normalizeQuestionLine(value) {
  return String(value || "")
    .replace(/^\s*คำถาม\s*[:：]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeAnswerLine(value) {
  return String(value || "")
    .replace(/^\s*คำตอบ\s*[:：]\s*/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitImportBlocks(qaText) {
  const lines = String(qaText || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");

  const blocks = [];
  let currentBlock = null;
  let sawQuestionNumber = false;

  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const trimmed = line.trim();

    if (!trimmed) {
      if (currentBlock) {
        currentBlock.lines.push("");
      }
      continue;
    }

    const numberMatch = trimmed.match(/^(\d+)\s*[.)]\s*(.*)$/u);
    if (numberMatch) {
      sawQuestionNumber = true;
      if (currentBlock) {
        blocks.push(currentBlock);
      }

      currentBlock = {
        order: Number(numberMatch[1]),
        lines: [],
      };

      if (numberMatch[2]) {
        currentBlock.lines.push(numberMatch[2]);
      }

      continue;
    }

    if (!currentBlock) {
      throw makeImportError("รูปแบบ Q&A ไม่ถูกต้อง: ต้องเริ่มแต่ละข้อด้วยเลขลำดับ เช่น `1.`");
    }

    currentBlock.lines.push(line);
  }

  if (currentBlock) {
    blocks.push(currentBlock);
  }

  if (!sawQuestionNumber || blocks.length === 0) {
    throw makeImportError("ไม่พบรายการ Q&A ในข้อความที่วาง");
  }

  return blocks;
}

function parseImportBlock(block, index) {
  const answerIndex = block.lines.findIndex((line) => /^\s*คำตอบ\s*[:：]/u.test(String(line || "")));

  if (answerIndex < 0) {
    throw makeImportError(`ข้อที่ ${index + 1} ไม่พบบรรทัดคำตอบ:`);
  }

  const questionLines = block.lines.slice(0, answerIndex).map((line, lineIndex) => {
    if (lineIndex === 0) {
      return normalizeQuestionLine(line);
    }

    return String(line || "").trim();
  });

  const questionText = questionLines
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const answerHead = normalizeAnswerLine(block.lines[answerIndex]);
  const answerTail = block.lines.slice(answerIndex + 1).map((line) => String(line || "").trim());
  const answerText = [answerHead, ...answerTail]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!questionText) {
    throw makeImportError(`ข้อที่ ${index + 1} ไม่พบคำถาม`);
  }

  if (!answerText) {
    throw makeImportError(`ข้อที่ ${index + 1} ไม่พบคำตอบ`);
  }

  return {
    displayOrder: index + 1,
    questionText,
    answerText,
  };
}

function buildQaBulkPreviewRows({
  qaText,
  sourceReference = "",
  domain = "legal",
  target = "all",
} = {}) {
  const blocks = splitImportBlocks(qaText);
  const normalizedDomain = normalizeImportDomain(domain);
  const normalizedTarget = normalizeImportTarget(target);
  const normalizedSourceReference = String(sourceReference || "").trim();

  return blocks.map((block, index) => {
    const parsed = parseImportBlock(block, index);
    return {
      domain: normalizedDomain,
      target: normalizedTarget,
      questionText: parsed.questionText,
      answerText: parsed.answerText,
      sourceReference: normalizedSourceReference,
      displayOrder: parsed.displayOrder,
      isActive: 1,
      normalizedQuestion: normalizeImportText(parsed.questionText),
    };
  });
}

function normalizePreviewRow(row, index, fallback = {}) {
  const questionText = String(row?.questionText || row?.question_text || "").trim();
  const answerText = String(row?.answerText || row?.answer_text || "").trim();

  if (!questionText || !answerText) {
    throw makeImportError(`ข้อมูล preview แถวที่ ${index + 1} ไม่ถูกต้อง`);
  }

  return {
    domain: normalizeImportDomain(row?.domain || fallback.domain),
    target: normalizeImportTarget(row?.target || fallback.target),
    questionText,
    answerText,
    sourceReference: String(row?.sourceReference || row?.source_reference || fallback.sourceReference || "").trim(),
    displayOrder: Number.isFinite(Number(row?.displayOrder ?? row?.display_order))
      ? Math.max(0, Math.floor(Number(row?.displayOrder ?? row?.display_order)))
      : index + 1,
    isActive: 1,
  };
}

async function saveQaBulkPreviewRows(previewRows = []) {
  if (!Array.isArray(previewRows) || previewRows.length === 0) {
    throw makeImportError("ไม่พบข้อมูล preview สำหรับบันทึก");
  }

  const fallback = {
    domain: previewRows[0]?.domain,
    target: previewRows[0]?.target,
    sourceReference: previewRows[0]?.sourceReference,
  };

  const rows = previewRows.map((row, index) => normalizePreviewRow(row, index, fallback));
  const result = await ChatbotSuggestedQuestionModel.createMany(rows);

  return {
    insertedRows: result?.insertedRows || rows.length,
  };
}

module.exports = {
  buildQaBulkPreviewRows,
  normalizeImportDomain,
  normalizeImportTarget,
  normalizeImportText,
  saveQaBulkPreviewRows,
  splitImportBlocks,
};
