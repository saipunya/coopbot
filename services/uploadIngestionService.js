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
const PDF_CHUNK_MIN_QUALITY_SCORE = Number(process.env.PDF_CHUNK_MIN_QUALITY_SCORE || 25);

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

function filterChunksByQuality(chunks) {
  const analyzedChunks = chunks.map((chunk, index) => {
    const analysis = analyzeChunkQuality(chunk);
    return {
      index,
      chunk,
      analysis,
    };
  });

  const kept = analyzedChunks.filter((item) => item.analysis.qualityScore >= PDF_CHUNK_MIN_QUALITY_SCORE);
  let fallbackKept = false;
  let finalKept = kept;

  if (finalKept.length === 0 && analyzedChunks.length > 0) {
    fallbackKept = true;
    finalKept = analyzedChunks
      .slice()
      .sort((left, right) => {
        const rightScore = Number(right.analysis?.qualityScore || 0);
        const leftScore = Number(left.analysis?.qualityScore || 0);
        return rightScore - leftScore;
      })
      .slice(0, Math.min(3, analyzedChunks.length));
  }

  const keptIndexSet = new Set(finalKept.map((item) => item.index));
  const removed = analyzedChunks.filter((item) => !keptIndexSet.has(item.index));

  return {
    filteredChunks: finalKept
      .slice()
      .sort((left, right) => left.index - right.index)
      .map((item) => item.chunk),
    summary: {
      beforeCount: analyzedChunks.length,
      afterCount: finalKept.length,
      removedCount: removed.length,
      threshold: PDF_CHUNK_MIN_QUALITY_SCORE,
      fallbackKept,
      keptScores: finalKept.map((item) => Number(item.analysis?.qualityScore || 0)),
      removedPreview: removed.slice(0, 5).map((item) => ({
        score: Number(item.analysis?.qualityScore || 0),
        notes: Array.isArray(item.analysis?.notes) ? item.analysis.notes.slice(0, 3) : [],
      })),
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
    const chunkFilterResult = filterChunksByQuality(chunks);
    const filteredChunks = chunkFilterResult.filteredChunks;
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
      chunkFilterResult.summary.removedCount > 0
        ? `กรอง chunk: ${chunkFilterResult.summary.afterCount}/${chunkFilterResult.summary.beforeCount}`
        : "",
    ]
      .filter(Boolean)
      .join(" | ");

    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      processingMessage: `กำลังสร้างดัชนีเอกสาร ${filteredChunks.length} ส่วน${extractionSummary ? ` | ${extractionSummary}` : ""}`,
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
      isSearchable: indexingDecision.isSearchable,
      qualityStatus: indexingDecision.qualityStatus,
    });

    if (!indexingDecision.isSearchable) {
      LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
        status: "quarantined",
        processingMessage: `นำเข้าแบบกักกันแล้ว ยังไม่ถูกใช้ค้นหา${extractionSummary ? ` | ${extractionSummary}` : ""}`,
        insertedChunkCount: 0,
        title: documentRecord.title || file.originalname,
        documentNumber: documentRecord.documentNumber || "",
        documentDateText: documentRecord.documentDateText || "",
        documentSource: documentRecord.documentSource || "",
      });
      return;
    }

    const documentKeywords = await extractDocumentKeywords(extractedText);
    const chunkRecords = await mapWithConcurrency(
      filteredChunks,
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
      beforeCount: chunkFilterResult.summary.beforeCount,
      afterCount: chunkFilterResult.summary.afterCount,
      removedCount: chunkFilterResult.summary.removedCount,
      threshold: chunkFilterResult.summary.threshold,
      fallbackKept: chunkFilterResult.summary.fallbackKept,
      keptScores: chunkFilterResult.summary.keptScores,
      removedPreview: chunkFilterResult.summary.removedPreview,
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
