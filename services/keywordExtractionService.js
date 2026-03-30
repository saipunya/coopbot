const { GoogleGenAI } = require("@google/genai");
const { segmentWords, uniqueTokens } = require("./thaiTextUtils");

const fallbackStopWords = new Set([
  "และ",
  "หรือ",
  "ของ",
  "ที่",
  "ใน",
  "การ",
  "เป็น",
  "ให้",
  "ได้",
  "จาก",
  "ตาม",
  "โดย",
  "กับ",
  "เพื่อ",
  "ว่า",
  "ซึ่ง",
  "มี",
  "นี้",
  "นั้น",
  "เอกสาร",
  "ระบบ",
  "ทดสอบ",
  "สำหรับ",
  "อัป",
  "โหลด",
]);

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

function extractFallbackKeywords(text) {
  const matches = segmentWords(text);
  const counts = new Map();

  for (const rawWord of matches) {
    const word = rawWord.toLowerCase();
    if (word.length < 2) {
      continue;
    }
    if (fallbackStopWords.has(word)) {
      continue;
    }
    counts.set(word, (counts.get(word) || 0) + 1);
  }

  return uniqueTokens(
    [...counts.entries()]
      .sort((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }
        return String(right[0]).length - String(left[0]).length;
      })
      .slice(0, 8)
      .map(([word]) => word)
  );
}

async function extractKeywords(text) {
  const safeText = String(text || "").trim();

  if (!safeText) {
    return [];
  }

  const gemini = getGeminiClient();
  if (!gemini) {
    return extractFallbackKeywords(safeText);
  }

  try {
    const response = await gemini.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: safeText.slice(0, 5000),
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: { type: "STRING" },
        },
        systemInstruction:
          "สกัด keyword ภาษาไทยจากข้อความกฎหมายที่ได้รับ ให้เป็นคำสั้น 3 ถึง 8 คำเท่านั้น และตอบกลับเป็น JSON array ของ string เท่านั้น",
      },
    });

    const parsed = JSON.parse(String(response.text || "[]"));
    if (!Array.isArray(parsed)) {
      return extractFallbackKeywords(safeText);
    }
    return uniqueTokens(
      parsed.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    );
  } catch (error) {
    return extractFallbackKeywords(safeText);
  }
}

async function extractDocumentKeywords(text) {
  const safeText = String(text || "").trim();
  if (!safeText) {
    return [];
  }

  const gemini = getGeminiClient();
  if (!gemini) {
    return extractFallbackKeywords(safeText);
  }

  try {
    const response = await gemini.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: safeText.slice(0, 12000),
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "ARRAY",
          items: { type: "STRING" },
        },
        systemInstruction:
          "อ่านเอกสารกฎหมายที่ได้รับและสกัด keyword ภาษาไทยที่สำคัญที่สุด 5 ถึง 12 คำ เพื่อนำไปใช้ค้นหาเอกสาร ให้ตอบกลับเป็น JSON array ของ string เท่านั้น",
      },
    });

    const parsed = JSON.parse(String(response.text || "[]"));
    if (!Array.isArray(parsed)) {
      return extractFallbackKeywords(safeText);
    }

    return uniqueTokens(parsed.map((item) => String(item).trim()).filter(Boolean)).slice(0, 12);
  } catch (error) {
    return extractFallbackKeywords(safeText);
  }
}

module.exports = {
  extractKeywords,
  extractDocumentKeywords,
};
