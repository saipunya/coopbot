const fs = require("fs/promises");
const path = require("path");
const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");
const { createCanvas } = require("@napi-rs/canvas");
const { createWorker } = require("tesseract.js");

const extractor = new WordExtractor();
let ocrWorkerPromise = null;

function normalizeText(text) {
  return String(text || "")
    .replace(/\u0000/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function chunkText(text, maxLength = 1400) {
  const paragraphs = normalizeText(text)
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  const chunks = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxLength) {
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

  return normalizeText(pages.join("\n\n"));
}

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = createWorker("tha+eng");
  }
  return ocrWorkerPromise;
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

  return normalizeText(pages.join("\n\n"));
}

async function extractPdfText(filePath) {
  const document = await loadPdfDocument(filePath);
  const textLayer = await extractPdfTextLayer(document);
  const minimumTextLength = Number(process.env.PDF_TEXT_MIN_LENGTH || 80);

  if (textLayer.length >= minimumTextLength) {
    return textLayer;
  }

  return extractPdfTextWithOcr(document);
}

async function extractDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return normalizeText(result.value);
}

async function extractDocText(filePath) {
  const document = await extractor.extract(filePath);
  return normalizeText(document.getBody());
}

async function extractTextFromFile(file) {
  const extension = path.extname(file.originalname || file.filename || "").toLowerCase();

  if (extension === ".pdf") {
    return extractPdfText(file.path);
  }

  if (extension === ".docx") {
    return extractDocxText(file.path);
  }

  if (extension === ".doc") {
    return extractDocText(file.path);
  }

  throw new Error("Unsupported file type for text extraction.");
}

module.exports = {
  chunkText,
  extractTextFromFile,
  normalizeText,
};
