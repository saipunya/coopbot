const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const { clearAnswerCache } = require("./answerStateService");
const {
  chunkText,
  extractTextResultFromFile,
} = require("./documentTextExtractor");
const {
  extractKeywords,
  extractDocumentKeywords,
} = require("./keywordExtractionService");
const { extractDocumentMetadata } = require("./documentMetadataService");
const { uniqueTokens } = require("./thaiTextUtils");

const KEYWORD_CONCURRENCY = Number(process.env.KEYWORD_CONCURRENCY || 4);

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
    ]
      .filter(Boolean)
      .join(" | ");

    LawChatbotPdfChunkModel.updateUpload(uploadRecord.id, {
      processingMessage: `กำลังสร้างดัชนีเอกสาร ${chunks.length} ส่วน${extractionSummary ? ` | ${extractionSummary}` : ""}`,
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
      chunks,
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
