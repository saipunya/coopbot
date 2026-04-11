const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");
const { createCanvas } = require("@napi-rs/canvas");
const { createWorker } = require("tesseract.js");
const { normalizeThaiPdfText } = require("./thaiPdfTextNormalizer");

const extractor = new WordExtractor();
const execFileAsync = promisify(execFile);
let ocrWorkerState = null;
const COMMON_THAI_DOCUMENT_TERMS = [
  "มาตรา",
  "สหกรณ์",
  "สมาชิก",
  "คณะกรรมการ",
  "ประชุม",
  "นายทะเบียน",
  "พระราชบัญญัติ",
  "ข้อบังคับ",
  "กิจการ",
  "อำนาจ",
  "หน้าที่",
  "ตาม",
  "และ",
  "หรือ",
  "ให้",
  "ของ",
];

function parseBooleanEnv(name, defaultValue = false) {
  return String(process.env[name] || String(defaultValue))
    .trim()
    .toLowerCase() === "true";
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getPdfOcrLanguages() {
  return String(process.env.PDF_OCR_LANGS || "tha+eng").trim() || "tha+eng";
}

function analyzeExtractedText(text) {
  const normalized = normalizeText(text);
  const minimumTextLength = Number(process.env.PDF_TEXT_MIN_LENGTH || 80);
  const thaiChars = (normalized.match(/[\u0E00-\u0E7F]/g) || []).length;
  const latinChars = (normalized.match(/[A-Za-z]/g) || []).length;
  const replacementGlyphHits = (normalized.match(/�||||||||||||||/g) || []).length;
  const garbledSpacingHits = (normalized.match(/[ก-๙]\s(?=[ก-๙])/g) || []).length;
  const thaiGarbledHits = (
    normalized.match(/[็์ิีุู่้๊๋]{3,}|~็|็~|◊|Ë|‡|∫|≈|¡|¥|å|ì|î|ï|ñ|ó|ô|ö|ù|û|ü/g) || []
  ).length;
  // Exclude common whitespace controls (\t,\n,\r) which are normal in extracted documents.
  const controlCharHits = (normalized.match(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g) || []).length;
  const digitChars = (normalized.match(/[0-9๐-๙]/g) || []).length;
  const commonThaiTermHits = COMMON_THAI_DOCUMENT_TERMS.reduce(
    (sum, term) => sum + (normalized.includes(term) ? 1 : 0),
    0,
  );
  const totalLetters = thaiChars + latinChars;
  const thaiRatio = totalLetters > 0 ? thaiChars / totalLetters : 0;
  const letterCoverage = normalized.length > 0 ? totalLetters / normalized.length : 0;

  let qualityScore = 100;
  const notes = [];

  if (normalized.length < minimumTextLength) {
    qualityScore -= 35;
    notes.push("ข้อความสั้นผิดปกติ");
  }

  if (replacementGlyphHits >= 4) {
    qualityScore -= 25;
    notes.push("พบอักขระแทนที่ผิดปกติ");
  }

  if (normalized.length > 0 && replacementGlyphHits / normalized.length > 0.01) {
    qualityScore -= 15;
  }

  // Thai legal PDFs should usually contain a healthy amount of Thai script.
  if (totalLetters >= 120 && thaiChars > 0 && thaiRatio < Number(process.env.PDF_THAI_RATIO_MIN || 0.35)) {
    qualityScore -= 20;
    notes.push("สัดส่วนอักษรไทยต่ำผิดปกติ");
  }

  // Text layers that split almost every Thai word into single-character spacing
  // tend to search very poorly, so OCR gives better recall.
  if (garbledSpacingHits >= 20) {
    qualityScore -= 25;
    notes.push("พบช่องว่างคั่นอักษรไทยผิดปกติ");
  }

  if (thaiGarbledHits > 0) {
    qualityScore -= Math.min(thaiGarbledHits, 20) * 2;
    notes.push("พบรูปแบบ OCR ภาษาไทยที่เพี้ยน");
  }

  if (controlCharHits > 5) {
    qualityScore -= Math.min(controlCharHits, 20);
    notes.push("พบ control characters มากผิดปกติ");
  }

  if (normalized.length >= 40 && letterCoverage < 0.2 && digitChars >= 10) {
    qualityScore -= 30;
    notes.push("สัดส่วนตัวอักษรต่ำผิดปกติ");
  }

  if (normalized.length >= 40 && thaiChars >= 20 && commonThaiTermHits === 0) {
    qualityScore -= 30;
    notes.push("ไม่พบศัพท์กฎหมายไทยที่คาดหวัง");
  }

  if (normalized.length >= 80 && thaiChars >= 40 && commonThaiTermHits <= 1) {
    qualityScore -= 30;
    notes.push("พบศัพท์กฎหมายไทยน้อยผิดปกติ");
  }

  qualityScore = Math.max(0, Math.min(100, Math.round(qualityScore)));

  const shouldFallbackToOcr =
    normalized.length < minimumTextLength ||
    replacementGlyphHits >= 4 ||
    (normalized.length > 0 && replacementGlyphHits / normalized.length > 0.01) ||
    (totalLetters >= 120 && thaiChars > 0 && thaiRatio < Number(process.env.PDF_THAI_RATIO_MIN || 0.35)) ||
    garbledSpacingHits >= 20 ||
    thaiGarbledHits >= 2;

  return {
    normalizedText: normalized,
    qualityScore,
    thaiChars,
    latinChars,
    thaiRatio,
    replacementGlyphHits,
    garbledSpacingHits,
    thaiGarbledHits,
    controlCharHits,
    digitChars,
    commonThaiTermHits,
    letterCoverage,
    shouldFallbackToOcr,
    notes,
  };
}

function shouldFallbackToPdfOcr(text) {
  return analyzeExtractedText(text).shouldFallbackToOcr;
}

function splitTextIntoLegalSections(text) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }

  const headingPattern = /(มาตรา\s*[0-9๐-๙]+(?:\s*(?:ทวิ|ตรี|จัตวา|เบญจ))?|ข้อ\s*[0-9๐-๙]+(?:\s*(?:ทวิ|ตรี|จัตวา|เบญจ))?)/g;
  const headings = [];
  let match = headingPattern.exec(normalized);

  while (match) {
    headings.push({
      index: match.index,
      text: String(match[0] || "").trim(),
    });
    match = headingPattern.exec(normalized);
  }

  if (headings.length === 0) {
    return [];
  }

  const sections = [];
  if (headings[0].index > 0) {
    const intro = normalized.slice(0, headings[0].index).trim();
    if (intro) {
      sections.push(intro);
    }
  }

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const next = headings[index + 1];
    const start = current.index;
    const end = next ? next.index : normalized.length;
    const sectionText = normalized.slice(start, end).trim();
    if (sectionText) {
      sections.push(sectionText);
    }
  }

  return sections.filter(Boolean);
}

function splitLargeSection(section, maxLength) {
  const paragraphs = String(section || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length === 0) {
    return [];
  }

  const chunks = [];

  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxLength) {
      chunks.push(paragraph);
      continue;
    }

    const sentenceParts = paragraph
      .split(/(?<=[.!?。！？])\s+|\n+/)
      .map((part) => part.trim())
      .filter(Boolean);

    if (sentenceParts.length > 1) {
      let currentSentenceChunk = "";

      for (const sentence of sentenceParts) {
        if (sentence.length > maxLength) {
          if (currentSentenceChunk) {
            chunks.push(currentSentenceChunk.trim());
            currentSentenceChunk = "";
          }

          for (let offset = 0; offset < sentence.length; offset += maxLength) {
            chunks.push(sentence.slice(offset, offset + maxLength).trim());
          }
          continue;
        }

        const candidate = currentSentenceChunk
          ? `${currentSentenceChunk}\n${sentence}`
          : sentence;

        if (candidate.length > maxLength) {
          if (currentSentenceChunk) {
            chunks.push(currentSentenceChunk.trim());
          }
          currentSentenceChunk = sentence;
        } else {
          currentSentenceChunk = candidate;
        }
      }

      if (currentSentenceChunk) {
        chunks.push(currentSentenceChunk.trim());
      }
      continue;
    }

    for (let offset = 0; offset < paragraph.length; offset += maxLength) {
      chunks.push(paragraph.slice(offset, offset + maxLength).trim());
    }
  }

  return chunks.filter(Boolean);
}

function chunkText(text, maxLength = 1400) {
  const normalizedText = normalizeText(text);
  const legalSections = splitTextIntoLegalSections(normalizedText);
  const sourceBlocks = legalSections.length > 0
    ? legalSections
    : normalizedText
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean);

  if (legalSections.length > 0) {
    const chunks = [];

    for (const block of sourceBlocks) {
      if (block.length <= maxLength) {
        chunks.push(block);
        continue;
      }

      chunks.push(...splitLargeSection(block, maxLength));
    }

    return chunks.filter(Boolean);
  }

  const chunks = [];
  let currentChunk = "";

  for (const paragraph of sourceBlocks) {
    if (paragraph.length > maxLength) {
      if (legalSections.length > 0) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = "";
        }

        const sectionChunks = splitLargeSection(paragraph, maxLength);
        chunks.push(...sectionChunks);
        continue;
      }

      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = "";
      }

      for (let index = 0; index < paragraph.length; index += maxLength) {
        chunks.push(paragraph.slice(index, index + maxLength).trim());
      }
      continue;
    }

    const candidate = currentChunk ? `${currentChunk}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxLength) {
      chunks.push(currentChunk.trim());
      currentChunk = paragraph;
    } else {
      currentChunk = candidate;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(Boolean);
}

async function loadPdfDocument(filePath) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const buffer = await fs.readFile(filePath);
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
  }).promise;
}

async function extractPdfTextLayer(document) {
  const pages = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const items = textContent.items
      .filter((item) => item && typeof item.str === "string" && item.str.trim())
      .map((item) => ({
        text: item.str.trim(),
        x: Number(item.transform?.[4] || 0),
        y: Number(item.transform?.[5] || 0),
      }))
      .sort((left, right) => {
        if (Math.abs(right.y - left.y) > 2) {
          return right.y - left.y;
        }
        return left.x - right.x;
      });

    const lines = [];

    for (const item of items) {
      const lastLine = lines[lines.length - 1];
      if (!lastLine || Math.abs(lastLine.y - item.y) > 2) {
        lines.push({ y: item.y, parts: [item.text] });
      } else {
        lastLine.parts.push(item.text);
      }
    }

    pages.push(lines.map((line) => line.parts.join(" ")).join("\n"));
  }

  return normalizeThaiPdfText(normalizeText(pages.join("\n\n")));
}

async function getOcrWorker() {
  const langs = getPdfOcrLanguages();
  if (!ocrWorkerState || ocrWorkerState.langs !== langs) {
    ocrWorkerState = {
      langs,
      promise: createWorker(langs),
    };
  }
  return ocrWorkerState.promise;
}

async function renderPdfPageToImage(document, pageNumber) {
  const page = await document.getPage(pageNumber);
  const viewport = page.getViewport({ scale: Number(process.env.PDF_OCR_SCALE || 2.5) });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  return canvas.toBuffer("image/png");
}

async function extractPdfTextWithOcr(document) {
  const worker = await getOcrWorker();
  const pageLimit = Math.min(document.numPages, Number(process.env.PDF_OCR_MAX_PAGES || 20));
  const pages = [];

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    const imageBuffer = await renderPdfPageToImage(document, pageNumber);
    const result = await worker.recognize(imageBuffer);
    pages.push(result?.data?.text || "");
  }

  return normalizeThaiPdfText(normalizeText(pages.join("\n\n")));
}

function buildOcrmypdfArgs(inputPath, outputPath) {
  const args = ["-l", String(process.env.PDF_OCRMYPDF_LANGS || getPdfOcrLanguages())];
  const mode = String(process.env.PDF_OCRMYPDF_MODE || "force")
    .trim()
    .toLowerCase();

  if (parseBooleanEnv("PDF_OCRMYPDF_ROTATE_PAGES", true)) {
    args.push("--rotate-pages");
  }

  if (mode === "redo") {
    args.push("--redo-ocr");
  } else if (mode === "skip-text") {
    args.push("--skip-text");
  } else {
    args.push("--force-ocr");
  }

  if (parseBooleanEnv("PDF_OCRMYPDF_DESKEW", true) && mode !== "redo") {
    args.push("--deskew");
  }

  const jobs = Number(process.env.PDF_OCRMYPDF_JOBS || 0);
  if (Number.isFinite(jobs) && jobs > 0) {
    args.push("--jobs", String(jobs));
  }

  args.push(inputPath, outputPath);
  return args;
}

function summarizeCommandFailure(error) {
  const raw = [error?.stderr, error?.stdout, error?.message]
    .filter(Boolean)
    .join("\n");
  const lines = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const primaryLine =
    lines.find((line) => !/^See the online documentation/i.test(line)) ||
    lines[0] ||
    "command_failed";

  if (/does not have language data/i.test(primaryLine)) {
    return "ocrmypdf_missing_language_data";
  }

  if (/not found|enoent/i.test(primaryLine)) {
    return "ocrmypdf_not_installed";
  }

  return primaryLine.slice(0, 180);
}

async function preprocessPdfWithOcrmypdf(filePath) {
  if (!parseBooleanEnv("PDF_PREPROCESS_WITH_OCRMYPDF")) {
    return {
      applied: false,
      note: "",
      cleanup: async () => {},
      filePath,
    };
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "coopbot-ocrmypdf-"));
  const outputPath = path.join(tempDir, `${path.basename(filePath, path.extname(filePath))}-searchable.pdf`);
  const cleanup = async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  };

  try {
    const args = buildOcrmypdfArgs(filePath, outputPath);
    await execFileAsync(process.env.OCRMYPDF_BIN || "ocrmypdf", args, {
      maxBuffer: 1024 * 1024 * 16,
    });

    return {
      applied: true,
      note: "preprocessed_with_ocrmypdf",
      cleanup,
      filePath: outputPath,
    };
  } catch (error) {
    await cleanup();

    return {
      applied: false,
      note: summarizeCommandFailure(error),
      cleanup: async () => {},
      filePath,
    };
  }
}

async function extractPdfTextDetailed(filePath) {
  const preprocessing = await preprocessPdfWithOcrmypdf(filePath);

  try {
    const document = await loadPdfDocument(preprocessing.filePath);
    const notes = [];

    if (preprocessing.note) {
      notes.push(preprocessing.note);
    }

    if (parseBooleanEnv("PDF_FORCE_OCR")) {
      const ocrText = await extractPdfTextWithOcr(document);
      const normalizedOcrText = normalizeThaiPdfText(ocrText);
      const ocrAnalysis = analyzeExtractedText(normalizedOcrText);

      return {
        text: normalizedOcrText,
        extractionMethod: preprocessing.applied ? "ocrmypdf+tesseract_ocr" : "tesseract_ocr",
        qualityScore: ocrAnalysis.qualityScore,
        notes: [...notes, ...ocrAnalysis.notes],
      };
    }

    const textLayer = await extractPdfTextLayer(document);
    const normalizedTextLayer = normalizeThaiPdfText(textLayer);
    const textLayerAnalysis = analyzeExtractedText(normalizedTextLayer);

    if (!textLayerAnalysis.shouldFallbackToOcr) {
      return {
        text: normalizedTextLayer,
        extractionMethod: preprocessing.applied ? "ocrmypdf_text_layer" : "pdf_text_layer",
        qualityScore: textLayerAnalysis.qualityScore,
        notes: [...notes, ...textLayerAnalysis.notes],
      };
    }

    const ocrText = await extractPdfTextWithOcr(document);
    const normalizedOcrText = normalizeThaiPdfText(ocrText);
    const ocrAnalysis = analyzeExtractedText(normalizedOcrText);
    const shouldPreferOcr = ocrAnalysis.qualityScore >= textLayerAnalysis.qualityScore;

    return {
      text: shouldPreferOcr ? normalizedOcrText : normalizedTextLayer,
      extractionMethod: shouldPreferOcr
        ? preprocessing.applied
          ? "ocrmypdf+tesseract_ocr"
          : "tesseract_ocr"
        : preprocessing.applied
          ? "ocrmypdf_text_layer"
          : "pdf_text_layer",
      qualityScore: shouldPreferOcr ? ocrAnalysis.qualityScore : textLayerAnalysis.qualityScore,
      notes: [
        ...notes,
        ...(shouldPreferOcr ? ocrAnalysis.notes : textLayerAnalysis.notes),
      ],
    };
  } finally {
    await preprocessing.cleanup();
  }
}

async function extractPdfText(filePath) {
  const result = await extractPdfTextDetailed(filePath);
  return result.text;
}

async function extractDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return normalizeText(result.value);
}

async function extractDocText(filePath) {
  const document = await extractor.extract(filePath);
  return normalizeText(document.getBody());
}

async function extractTextResultFromFile(file) {
  const extension = path.extname(file.originalname || file.filename || "").toLowerCase();

  if (extension === ".pdf") {
    return extractPdfTextDetailed(file.path);
  }

  if (extension === ".docx") {
    const text = await extractDocxText(file.path);
    const analysis = analyzeExtractedText(text);
    return {
      text,
      extractionMethod: "docx_text",
      qualityScore: analysis.qualityScore,
      notes: analysis.notes,
    };
  }

  if (extension === ".doc") {
    const text = await extractDocText(file.path);
    const analysis = analyzeExtractedText(text);
    return {
      text,
      extractionMethod: "doc_text",
      qualityScore: analysis.qualityScore,
      notes: analysis.notes,
    };
  }

  throw new Error("Unsupported file type for text extraction.");
}

async function extractTextFromFile(file) {
  const result = await extractTextResultFromFile(file);
  return result.text;
}

module.exports = {
  chunkText,
  analyzeExtractedText,
  extractTextFromFile,
  extractTextResultFromFile,
  normalizeText,
};
