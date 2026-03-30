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

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function parseThaiDateToIso(text) {
  const value = normalizeText(text);
  const match = value.match(/(\d{1,2})\s+([ก-๙]+)\s+(\d{4})/);
  if (!match) {
    return null;
  }

  const monthMap = {
    มกราคม: 1,
    กุมภาพันธ์: 2,
    มีนาคม: 3,
    เมษายน: 4,
    พฤษภาคม: 5,
    มิถุนายน: 6,
    กรกฎาคม: 7,
    สิงหาคม: 8,
    กันยายน: 9,
    ตุลาคม: 10,
    พฤศจิกายน: 11,
    ธันวาคม: 12,
  };

  const day = Number(match[1]);
  const month = monthMap[match[2]];
  let year = Number(match[3]);

  if (!month || !day || !year) {
    return null;
  }

  if (year > 2400) {
    year -= 543;
  }

  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractMetadataByRegex(text, file) {
  const safeText = String(text || "").slice(0, 6000);
  const originalname = String(file?.originalname || file?.filename || "").trim();
  const titleLine = safeText
    .split("\n")
    .map((line) => normalizeText(line))
    .find((line) => line.length >= 8 && line.length <= 180);

  const documentNumberMatch =
    safeText.match(/(?:ที่|เลขที่หนังสือ|หนังสือที่)\s*([A-Za-zก-๙0-9\/\-.]{3,80})/i) ||
    safeText.match(/([ก-๙A-Za-z]{1,10}\s*\d{1,6}\/\d{2,4})/);
  const dateMatch =
    safeText.match(/ลงวันที่\s*([0-9]{1,2}\s+[ก-๙]+\s+[0-9]{4})/) ||
    safeText.match(/วันที่\s*([0-9]{1,2}\s+[ก-๙]+\s+[0-9]{4})/);
  const sourceMatch =
    safeText.match(/(?:หน่วยงาน|ส่วนราชการ|สำนักงาน)\s*[:\-]?\s*([^\n]{4,180})/) ||
    safeText.match(/(สำนักงาน[^\n]{4,180})/);

  const documentDateText = dateMatch ? normalizeText(dateMatch[1]) : "";

  return {
    title: titleLine || originalname || "เอกสารอ้างอิง",
    documentNumber: documentNumberMatch ? normalizeText(documentNumberMatch[1]) : "",
    documentDateText,
    documentDate: parseThaiDateToIso(documentDateText),
    documentSource: sourceMatch ? normalizeText(sourceMatch[1]) : "",
  };
}

async function extractDocumentMetadata(text, file) {
  const fallback = extractMetadataByRegex(text, file);
  const gemini = getGeminiClient();

  if (!gemini) {
    return fallback;
  }

  try {
    const response = await gemini.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: String(text || "").slice(0, 12000),
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            documentNumber: { type: "STRING" },
            documentDateText: { type: "STRING" },
            documentSource: { type: "STRING" },
          },
        },
        systemInstruction:
          "อ่านเอกสารราชการหรือเอกสารกฎหมายที่ได้รับ แล้วสกัด metadata สำคัญเพื่อนำไปใช้อ้างอิง ได้แก่ title, documentNumber, documentDateText, documentSource ตอบกลับเป็น JSON object เท่านั้น ถ้าไม่พบให้ส่งค่าว่าง",
      },
    });

    const parsed = JSON.parse(String(response.text || "{}"));
    return {
      title: normalizeText(parsed.title) || fallback.title,
      documentNumber: normalizeText(parsed.documentNumber) || fallback.documentNumber,
      documentDateText: normalizeText(parsed.documentDateText) || fallback.documentDateText,
      documentDate:
        parseThaiDateToIso(parsed.documentDateText) ||
        fallback.documentDate ||
        null,
      documentSource: normalizeText(parsed.documentSource) || fallback.documentSource,
    };
  } catch (_) {
    return fallback;
  }
}

module.exports = {
  extractDocumentMetadata,
  parseThaiDateToIso,
};
