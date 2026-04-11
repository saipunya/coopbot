const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const { clearAnswerCache } = require("./answerStateService");
const {
  chunkText,
  analyzeExtractedText,
  extractTextResultFromFile,
} = require("./documentTextExtractor");
const {
  extractKeywords,
  extractDocumentKeywords,
} = require("./keywordExtractionService");
const { extractDocumentMetadata } = require("./documentMetadataService");
const { uniqueTokens } = require("./thaiTextUtils");

const KEYWORD_CONCURRENCY = Number(process.env.KEYWORD_CONCURRENCY || 4);
const PDF_CHUNK_ACCEPTED_QUALITY_SCORE = Number(process.env.PDF_CHUNK_ACCEPTED_QUALITY_SCORE || 60);
const PDF_CHUNK_LOW_QUALITY_SCORE = Number(process.env.PDF_CHUNK_LOW_QUALITY_SCORE || 45);

function getFileExtension(file = null) {
  return String(file?.originalname || file?.filename || "")
    .toLowerCase()
    .split(".")
    .pop();
}

function getChunkQualityThresholds(file = null) {
  const extension = getFileExtension(file);

  if (extension === "pdf") {
    return {
      acceptedThreshold: PDF_CHUNK_ACCEPTED_QUALITY_SCORE,
      lowQualityThreshold: PDF_CHUNK_LOW_QUALITY_SCORE,
    };
  }

  // DOC/DOCX are typically clean text, but can be short/bullet-y and score lower under PDF-oriented heuristics.
  // Use document-level minimum extraction score as a safer default to avoid dropping most chunks.
  const acceptedThreshold = Number(
    process.env.DOCUMENT_CHUNK_ACCEPTED_QUALITY_SCORE ||
      process.env.DOCUMENT_MIN_EXTRACTION_QUALITY_SCORE ||
      45,
  );
  const lowQualityThreshold = Number(
    process.env.DOCUMENT_CHUNK_LOW_QUALITY_SCORE ||
      Math.max(20, acceptedThreshold - 10),
  );

  return {
    acceptedThreshold,
    lowQualityThreshold,
  };
}

function getExtractionMethodLabel(method) {
  switch (String(method || "").trim()) {
    case "pdf_text_layer":
      return "PDF text layer";
    case "ocrmypdf_text_layer":
      return "OCRmyPDF text layer";
    case "tesseract_ocr":
      return "Tesseract OCR";
    case "ocrmypdf+tesseract_ocr":
      return "OCRmyPDF + Tesseract OCR";
    case "docx_text":
      return "DOCX text";
    case "doc_text":
      return "DOC text";
    default:
      return "";
  }
}

function getExtractionNoteLabel(note) {
  switch (String(note || "").trim()) {
    case "ocrmypdf_missing_language_data":
      return "OCRmyPDF ยังไม่มี language pack ภาษาไทย";
    case "ocrmypdf_not_installed":
      return "ยังไม่ได้ติดตั้ง OCRmyPDF";
    case "preprocessed_with_ocrmypdf":
      return "preprocess PDF ด้วย OCRmyPDF";
    default:
      return "";
  }
}

function getMinimumExtractionQualityScore(file = null) {
  const extension = String(file?.originalname || file?.filename || "")
    .toLowerCase()
    .split(".")
    .pop();

  if (extension === "pdf") {
    return Number(process.env.PDF_MIN_EXTRACTION_QUALITY_SCORE || process.env.DOCUMENT_MIN_EXTRACTION_QUALITY_SCORE || 50);
  }

  return Number(process.env.DOCUMENT_MIN_EXTRACTION_QUALITY_SCORE || 45);
}

function decideDocumentIndexing(extractionResult, file = null, chunkCount = 0) {
  const qualityScore = Number(extractionResult?.qualityScore);
  const minimumScore = getMinimumExtractionQualityScore(file);
  const notes = Array.isArray(extractionResult?.notes) ? extractionResult.notes : [];
  const extractionMethod = String(extractionResult?.extractionMethod || "").trim();
  const reliedOnOcr = extractionMethod.includes("tesseract_ocr");

  if (chunkCount <= 0 || !String(extractionResult?.text || "").trim()) {
    return {
      isSearchable: false,
      qualityStatus: "quarantined",
      reason: "ไม่พบข้อความที่นำไปสร้างดัชนีได้",
    };
  }

  if (Number.isFinite(qualityScore) && qualityScore < minimumScore) {
    return {
      isSearchable: false,
      qualityStatus: "quarantined",
      reason: `คะแนนคุณภาพข้อความต่ำกว่าเกณฑ์ (${qualityScore}/${minimumScore})`,
    };
  }

  if (reliedOnOcr && notes.includes("ocrmypdf_missing_language_data")) {
    return {
      isSearchable: false,
      qualityStatus: "quarantined",
      reason: "ยังไม่มี OCR ภาษาไทยพร้อมใช้งานบนเครื่องนี้",
    };
  }

  return {
    isSearchable: true,
    qualityStatus: "accepted",
    reason: "",
  };
}

function analyzeChunkQuality(chunkText) {
  const analysis = analyzeExtractedText(chunkText);
  return {
    ...analysis,
    chunkText,
  };
}

function filterChunksByQuality(chunks, thresholds = {}) {
  const acceptedThreshold = Number(thresholds.acceptedThreshold ?? PDF_CHUNK_ACCEPTED_QUALITY_SCORE);
  const lowQualityThreshold = Number(thresholds.lowQualityThreshold ?? PDF_CHUNK_LOW_QUALITY_SCORE);

  const analyzedChunks = chunks.map((chunk, index) => {
    const analysis = analyzeChunkQuality(chunk);
    const qualityScore = Number(analysis.qualityScore || 0);
    let qualityBand = "rejected";

    if (qualityScore >= acceptedThreshold) {
      qualityBand = "accepted";
    } else if (qualityScore >= lowQualityThreshold) {
      qualityBand = "lowQuality";
    }

    return {
      index,
      chunk,
      analysis,
      qualityBand,
    };
  });

  const acceptedChunks = analyzedChunks.filter((item) => item.qualityBand === "accepted");
  const lowQualityChunks = analyzedChunks.filter((item) => item.qualityBand === "lowQuality");
  const rejectedChunks = analyzedChunks.filter((item) => item.qualityBand === "rejected");

  const notes = [];
  if (acceptedChunks.length === 0 && analyzedChunks.length > 0) {
    notes.push("ไม่มี chunk ที่ผ่านเกณฑ์ accepted");
  }
  if (lowQualityChunks.length > 0) {
    notes.push(`มี low quality ${lowQualityChunks.length} chunk`);
  }
  if (rejectedChunks.length > 0) {
    notes.push(`มี rejected ${rejectedChunks.length} chunk`);
  }

  const summarizePreview = (items) =>
    items.slice(0, 5).map((item) => ({
      score: Number(item.analysis?.qualityScore || 0),
      notes: Array.isArray(item.analysis?.notes) ? item.analysis.notes.slice(0, 3) : [],
    }));

  return {
    acceptedChunks: acceptedChunks
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((item) => item.chunk),
    lowQualityChunks: lowQualityChunks
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((item) => item.chunk),
    rejectedChunks: rejectedChunks
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((item) => item.chunk),
    summary: {
      chunk_total: analyzedChunks.length,
      chunk_accepted: acceptedChunks.length,
      chunk_low_quality: lowQualityChunks.length,
      chunk_rejected: rejectedChunks.length,
      acceptedThreshold,
      lowQualityThreshold,
      notes,
      acceptedPreview: summarizePreview(acceptedChunks),
      lowQualityPreview: summarizePreview(lowQualityChunks),
      rejectedPreview: summarizePreview(rejectedChunks),
    },
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function processUploadInBackground(file, uploadRecord) {
  try {
    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      status: "processing",
      processingMessage: "กำลังอ่านไฟล์และแปลงข้อความ",
    });

    const extractionResult = await extractTextResultFromFile(file);
    const extractedText = extractionResult.text;
    const chunks = chunkText(extractedText, Number(process.env.CHUNK_SIZE || 1400));
    const chunkQualityThresholds = getChunkQualityThresholds(file);
    const chunkFilterResult = filterChunksByQuality(chunks, chunkQualityThresholds);
    const acceptedChunks = chunkFilterResult.acceptedChunks;
    const extension = getFileExtension(file);
    const indexableChunks = extension === "pdf"
      ? acceptedChunks
      : [...acceptedChunks, ...(chunkFilterResult.lowQualityChunks || [])];
    const documentMetadata = await extractDocumentMetadata(extractedText, file);
    const extractionMethodLabel = getExtractionMethodLabel(extractionResult.extractionMethod);
    const extractionNoteLabel = (extractionResult.notes || [])
      .map((note) => getExtractionNoteLabel(note))
      .find(Boolean);
    const indexingDecision = decideDocumentIndexing(extractionResult, file, chunks.length);
    const extractionSummary = [
      extractionMethodLabel ? `วิธีอ่าน: ${extractionMethodLabel}` : "",
      Number.isFinite(Number(extractionResult.qualityScore))
        ? `คุณภาพข้อความ: ${Math.max(0, Math.min(100, Number(extractionResult.qualityScore)))}/100`
        : "",
      extractionNoteLabel,
      indexingDecision.reason || "",
      `chunk_total: ${chunkFilterResult.summary.chunk_total}`,
      `chunk_accepted: ${chunkFilterResult.summary.chunk_accepted}`,
      `chunk_low_quality: ${chunkFilterResult.summary.chunk_low_quality}`,
      `chunk_rejected: ${chunkFilterResult.summary.chunk_rejected}`,
    ]
      .filter(Boolean)
      .join(" | ");

    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      processingMessage: `กำลังสร้างดัชนีเอกสาร ${indexableChunks.length} ส่วน${extractionSummary ? ` | ${extractionSummary}` : ""}`,
      title: documentMetadata.title || file.originalname,
      documentNumber: documentMetadata.documentNumber || "",
      documentDateText: documentMetadata.documentDateText || "",
      documentSource: documentMetadata.documentSource || "",
    });

    const documentRecord = await LawChatbotPdfChunkModel.createDocument({
      title: documentMetadata.title || file.originalname,
      documentNumber: documentMetadata.documentNumber || "",
      documentDate: documentMetadata.documentDate || null,
      documentDateText: documentMetadata.documentDateText || "",
      documentSource: documentMetadata.documentSource || "",
      filename: file.filename,
      originalname: file.originalname,
      mimetype: file.mimetype,
      fileSize: file.size,
      extractionMethod: extractionResult.extractionMethod || "",
      extractionQualityScore: extractionResult.qualityScore,
      extractionNotes: (extractionResult.notes || []).filter(Boolean).join(" | "),
      isSearchable: indexingDecision.isSearchable && indexableChunks.length > 0,
      qualityStatus:
        indexingDecision.isSearchable && indexableChunks.length > 0
          ? indexingDecision.qualityStatus
          : "quarantined",
    });

    if (!indexingDecision.isSearchable || indexableChunks.length === 0) {
      LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
        status: "quarantined",
        processingMessage: `นำเข้าแบบกักกันแล้ว ยังไม่ถูกใช้ค้นหา${extractionSummary ? ` | ${extractionSummary}` : ""}`,
        insertedChunkCount: 0,
        title: documentRecord.title || file.originalname,
        documentNumber: documentRecord.documentNumber || "",
        documentDateText: documentRecord.documentDateText || "",
        documentSource: documentRecord.documentSource || "",
      });
      console.info("PDF chunk quality filter summary:", {
        filename: file.originalname,
        documentId: documentRecord.id,
        ...chunkFilterResult.summary,
      });
      return;
    }

    const documentKeywords = await extractDocumentKeywords(extractedText);
    const chunkRecords = await mapWithConcurrency(
      indexableChunks,
      KEYWORD_CONCURRENCY,
      async (chunk) => {
        const chunkKeywords = await extractKeywords(chunk);
        const mergedKeywords = uniqueTokens([...documentKeywords, ...chunkKeywords]).slice(0, 12);

        return {
          keyword: mergedKeywords.join(", ").slice(0, 255) || "document",
          chunkText: chunk,
          documentId: documentRecord.id,
        };
      },
    );

    const insertedChunkCount = await LawChatbotPdfChunkModel.insertChunks(chunkRecords, documentRecord.id);

    console.info("PDF chunk quality filter summary:", {
      filename: file.originalname,
      documentId: documentRecord.id,
      ...chunkFilterResult.summary,
    });

    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      status: "completed",
      processingMessage: `นำเข้าข้อมูลเรียบร้อยแล้ว${extractionSummary ? ` | ${extractionSummary}` : ""}`,
      insertedChunkCount,
      title: documentRecord.title || file.originalname,
      documentNumber: documentRecord.documentNumber || "",
      documentDateText: documentRecord.documentDateText || "",
      documentSource: documentRecord.documentSource || "",
    });
  } catch (error) {
    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      status: "failed",
      processingMessage: error.message || "ไม่สามารถประมวลผลเอกสารได้",
    });
  }
}

async function recordUpload(file) {
  if (!file) {
    return null;
  }

  clearAnswerCache();

  const uploadRecord = LawChatbotPdfChunkModel.createUpload({
    filename: file.filename,
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    status: "queued",
    processingMessage: "รอเริ่มประมวลผล",
  });

  setImmediate(() => {
    void processUploadInBackground(file, uploadRecord);
  });

  return {
    filename: file.filename,
    originalname: file.originalname,
    insertedChunkCount: 0,
    status: "queued",
  };
}

module.exports = {
  recordUpload,
};
