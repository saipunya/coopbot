const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateKeywordFromChunk,
  isGarbageChunk,
  maybeMergeNeighborChunks,
  normalizeChunkText,
  splitIntoKnowledgeChunks,
} = require("../utils/chunkSplitter");

const sampleText =
  "โครงสร้างของสหกรณ์ ตั้งอยู่บนรากฐานของประชาธิปไตย สมาชิกทุกคนเป็นเจ้าของสหกรณ์ แต่ทุกคนไม่สามารถร่วมบริหารกิจการของสหกรณ์ได้ จึงต้องมีการเลือกตั้งคณะกรรมการดำเนินการเป็นผู้บริหารงานแทน ตามพระราชบัญญัติสหกรณ์ พ.ศ. 2542 กำหนดให้มีคณะกรรมการดำเนินการไม่เกิน 15 คน มีอำนาจหน้าที่เป็นผู้ดำเนินกิจการและเป็นผู้แทนสหกรณ์ในกิจการทั้งปวงเพื่อให้กิจการสหกรณ์ดำเนินการอย่างกว้างขวาง และให้บริการแก่สมาชิกอย่างทั่วถึง คณะกรรมการดำเนินการควรจัดจ้างผู้จัดการที่มีความรู้ความสามารถมาดำเนินธุรกิจแทน และผู้จัดการอาจจัดจ้างเจ้าหน้าที่โดยความเห็นชอบของคณะกรรมการดำเนินการ เพื่อช่วยเหลือกิจการสหกรณ์ด้านต่างๆ ตามความเหมาะสมโดยคำนึงถึงปริมาณธุรกิจและการประหยัดเป็นสำคัญ";

test("normalizeChunkText collapses whitespace but keeps meaning", () => {
  const normalized = normalizeChunkText("  โครงสร้างสหกรณ์  \n\n  ประชาธิปไตย  ");
  assert.equal(normalized, "โครงสร้างสหกรณ์\n\nประชาธิปไตย");
});

test("splitIntoKnowledgeChunks splits the cooperative structure sample into readable chunks", () => {
  const chunks = splitIntoKnowledgeChunks(sampleText, {
    baseKeyword: "โครงสร้างสหกรณ์",
    topic: "โครงสร้างสหกรณ์",
    minLength: 70,
    maxLength: 350,
    targetLength: 220,
  });

  assert.ok(chunks.length >= 5, `expected at least 5 chunks, got ${chunks.length}`);
  assert.ok(chunks.length <= 10, `expected at most 10 chunks, got ${chunks.length}`);
  assert.ok(chunks.every((chunk) => !isGarbageChunk(chunk.chunkText)));
  assert.ok(chunks.every((chunk) => typeof chunk.keyword === "string" && chunk.keyword.length > 0));
  assert.ok(chunks.every((chunk) => chunk.chunkText.length >= 35));

  const keywords = chunks.map((chunk) => chunk.keyword);
  assert.ok(keywords.some((keyword) => keyword.includes("โครงสร้างสหกรณ์") || keyword.includes("ประชาธิปไตย")));
  assert.ok(keywords.some((keyword) => keyword.includes("คณะกรรมการดำเนินการ")));
  assert.ok(keywords.some((keyword) => keyword.includes("ผู้จัดการสหกรณ์") || keyword.includes("เจ้าหน้าที่สหกรณ์")));
});

test("generateKeywordFromChunk prefers the committee authority theme", () => {
  const chunk =
    "ตามพระราชบัญญัติสหกรณ์ พ.ศ. 2542 กำหนดให้มีคณะกรรมการดำเนินการไม่เกิน 15 คน มีอำนาจหน้าที่เป็นผู้ดำเนินกิจการและเป็นผู้แทนสหกรณ์ในกิจการทั้งปวง";

  const keyword = generateKeywordFromChunk(chunk, {
    baseKeyword: "โครงสร้างสหกรณ์",
    topic: "โครงสร้างสหกรณ์",
  });

  assert.ok(keyword.includes("คณะกรรมการดำเนินการ"));
  assert.ok(keyword.includes("อำนาจหน้าที่") || keyword.includes("15 คน"));
});

test("maybeMergeNeighborChunks merges tiny fragments", () => {
  const merged = maybeMergeNeighborChunks(
    [
      { chunkText: "คณะกรรมการดำเนินการทำหน้าที่กำหนดนโยบายและควบคุมการบริหาร" },
      { chunkText: "กิจการให้เป็นไปตามข้อบังคับและประโยชน์ของสมาชิก" },
    ],
    { minLength: 80, maxLength: 350 },
  );

  assert.equal(merged.length, 1);
  assert.match(merged[0].chunkText, /คณะกรรมการดำเนินการ/);
  assert.match(merged[0].chunkText, /ข้อบังคับ/);
});
