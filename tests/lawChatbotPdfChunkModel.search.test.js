const test = require("node:test");
const assert = require("node:assert/strict");

const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const { normalizeThai } = require("../utils/thaiNormalizer");
const { expandKeywords } = require("../utils/synonyms");

function buildChunk(id, keyword, chunkText, overrides = {}) {
  return {
    id,
    keyword,
    chunk_text: chunkText,
    clean_text: normalizeThai(`${keyword} ${chunkText}`),
    is_active: 1,
    quality_score: 80,
    document_id: 1,
    ...overrides,
  };
}

function seedSearchFixtures() {
  const documents = [
    {
      id: 1,
      title: "เอกสารทดสอบระบบค้นหา PDF Chunks",
      documentNumber: "TEST-SEARCH-001",
      documentDateText: "15 เมษายน 2569",
      documentSource: "unit-test",
      originalname: "search-fixture.pdf",
      isSearchable: 1,
    },
  ];

  const chunks = [
    buildChunk(
      101,
      "คณะกรรมการดำเนินการ",
      "คณะกรรมการดำเนินการมีอำนาจหน้าที่บริหารกิจการสหกรณ์",
      { quality_score: 92 },
    ),
    buildChunk(
      102,
      "คพช",
      "คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ มีหน้าที่กำหนดนโยบายและแผนพัฒนาการสหกรณ์",
      { quality_score: 95 },
    ),
    buildChunk(
      103,
      "เลิกสหกรณ์",
      "การเลิกสหกรณ์อาจทำได้โดยการชำระบัญชี การยกเลิก และการยุบเลิกตามกฎหมาย",
      { quality_score: 90 },
    ),
    buildChunk(
      104,
      "นายทะเบียนสหกรณ์",
      "นายทะเบียนสหกรณ์มีอำนาจกำกับดูแลและวินิจฉัยเรื่องที่อยู่ในอำนาจหน้าที่",
      { quality_score: 86 },
    ),
    buildChunk(
      105,
      "โครงสร้างสหกรณ์",
      "โครงสร้างของสหกรณ์ตั้งอยู่บนรากฐานของประชาธิปไตย การมีส่วนร่วม และสมาชิกเป็นเจ้าของร่วม",
      { quality_score: 88 },
    ),
    buildChunk(
      106,
      "###",
      "~~ @@ ###",
      { clean_text: "", quality_score: 5 },
    ),
    buildChunk(
      107,
      "เอกสารแนบ",
      "หน้า 1 โทร 02-123-4567 fax 02-222-0000 email test@example.com",
      { quality_score: 10 },
    ),
    buildChunk(
      108,
      "คณะกรรมการดำเนินการ",
      "คณะกรรมการดำเนินการฉบับเก่าที่ไม่ควรถูกนำมาค้นคืน",
      { is_active: 0, quality_score: 99 },
    ),
    buildChunk(
      109,
      "อำนาจคณะกรรมการดำเนินการพิเศษ",
      "อำนาจคณะกรรมการดำเนินการพิเศษครอบคลุมการบริหารกิจการสหกรณ์และการกำหนดแนวทางดำเนินงาน",
      { quality_score: 98 },
    ),
    buildChunk(
      110,
      "อำนาจคณะกรรมการดำเนินการพิเศษ",
      "อำนาจคณะกรรมการดำเนินการพิเศษครอบคลุมการบริหารกิจการสหกรณ์และการกำหนดแนวทางดำเนินงาน",
      { quality_score: 55 },
    ),
    buildChunk(
      111,
      "จำนวนกรรมการดำเนินการ",
      "คณะกรรมการดำเนินการมีกรรมการเก้าคน และมาจากการเลือกตั้งตามข้อบังคับของสหกรณ์",
      { quality_score: 89 },
    ),
    buildChunk(
      112,
      "ข้อมูลขยะ OCR",
      "ËËË ◊◊◊ ~็~็ scanner page 1 fax email",
      { clean_text: "ข้อมูลขยะ ocr", quality_score: 1 },
    ),
  ];

  LawChatbotPdfChunkModel.__seedTestSearchData({ documents, chunks });
}

function getResultIds(results) {
  return results.map((row) => row.id);
}

function getResultKeywords(results) {
  return results.map((row) => row.keyword);
}

function getTopKeyword(results) {
  return results[0]?.keyword || "";
}

function printTopResults(results) {
  return results
    .map(
      (row, index) =>
        `${index + 1}. id=${row.id} keyword=${row.keyword} score=${row.score} reference=${row.reference}`,
    )
    .join("\n");
}

async function search(query, limit = 5) {
  const results = await LawChatbotPdfChunkModel.searchChunksSmart(query, limit);
  if (process.env.DEBUG_SEARCH_TESTS === "1") {
    // eslint-disable-next-line no-console
    console.log(`\nQUERY: ${query}\n${printTopResults(results)}\n`);
  }
  return results;
}

test.beforeEach(() => {
  seedSearchFixtures();
});

test.after(() => {
  LawChatbotPdfChunkModel.__resetTestState();
});

test("search helper sanity uses normalizer and synonym expansion", () => {
  assert.equal(normalizeThai("  คพช / สหกรณ์!!  "), "คพช สหกรณ์");
  assert.deepEqual(expandKeywords("คพช"), ["คพช", "คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ"]);
});

test("[Case 1] exact keyword returns the matching board row near the top", async () => {
  const results = await search("คณะกรรมการดำเนินการ", 5);
  const topIds = getResultIds(results).slice(0, 2);

  assert.ok(results.length > 0, "should return at least one result");
  assert.ok(
    topIds.includes(101),
    `expected exact keyword row 101 in top results:\n${printTopResults(results)}`,
  );
  assert.match(
    results.find((row) => row.id === 101)?.chunk_text || "",
    /อำนาจหน้าที่บริหารกิจการสหกรณ์/,
    `expected row 101 to be present with matching content:\n${printTopResults(results)}`,
  );
});

test("[Case 2] abbreviation query finds the full committee row", async () => {
  const results = await search("คพช", 5);

  assert.ok(results.length > 0, "should return results for abbreviation");
  assert.equal(results[0].id, 102, `expected คพช row first:\n${printTopResults(results)}`);
  assert.match(
    results[0].chunk_text,
    /คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ/,
    `expected full name in top result:\n${printTopResults(results)}`,
  );
});

test("[Case 3] synonym or near meaning keeps dissolution content in top results", async () => {
  const results = await search("เลิกสหกรณ์", 5);

  assert.ok(results.length > 0, "should return results for dissolution query");
  assert.equal(results[0].id, 103, `expected dissolution row first:\n${printTopResults(results)}`);
  assert.ok(
    /ชำระบัญชี|ยกเลิก|ยุบเลิก/.test(results[0].chunk_text),
    `expected top result to mention dissolution variants:\n${printTopResults(results)}`,
  );
});

test("[Case 4] OCR-like typo still finds the related national committee row", async () => {
  const results = await search("สหกรณแหงชาติ", 5);

  assert.ok(results.length > 0, "should return results for OCR-like typo");
  assert.ok(
    getResultIds(results).slice(0, 3).includes(102),
    `expected id 102 in top results:\n${printTopResults(results)}`,
  );
});

test("[Case 5] democratic structure query prioritizes the structure content", async () => {
  const results = await search("โครงสร้างของสหกรณ์", 5);

  assert.ok(results.length > 0, "should return results for structure query");
  assert.equal(results[0].id, 105, `expected structure row first:\n${printTopResults(results)}`);
  assert.match(results[0].chunk_text, /ประชาธิปไตย/, `unexpected top result:\n${printTopResults(results)}`);
});

test("[Case 6] garbage rows do not outrank meaningful cooperative content", async () => {
  const results = await search("สหกรณ์", 10);
  const topIds = getResultIds(results).slice(0, 5);

  assert.ok(results.length > 0, "should return results for broad query");
  assert.ok(!topIds.includes(106), `garbage row 106 should not be in top results:\n${printTopResults(results)}`);
  assert.ok(!topIds.includes(107), `garbage row 107 should not be in top results:\n${printTopResults(results)}`);
  assert.ok(
    getResultKeywords(results).slice(0, 3).some((keyword) => keyword && !["###", "เอกสารแนบ"].includes(keyword)),
    `expected useful rows above garbage:\n${printTopResults(results)}`,
  );
});

test("[Case 7] inactive chunk is excluded from search results", async () => {
  const results = await search("คณะกรรมการดำเนินการ", 10);

  assert.ok(results.length > 0, "should return active results");
  assert.ok(
    !getResultIds(results).includes(108),
    `inactive chunk 108 must not be returned:\n${printTopResults(results)}`,
  );
});

test("[Case 8] quality score influences ordering when relevance is close", async () => {
  const results = await search("อำนาจคณะกรรมการดำเนินการพิเศษ", 10);
  const highQualityIndex = results.findIndex((row) => row.id === 109);
  const lowQualityIndex = results.findIndex((row) => row.id === 110);

  assert.notEqual(highQualityIndex, -1, `missing high quality row:\n${printTopResults(results)}`);
  assert.notEqual(lowQualityIndex, -1, `missing low quality row:\n${printTopResults(results)}`);
  assert.ok(
    highQualityIndex < lowQualityIndex,
    `high quality row should rank above low quality row:\n${printTopResults(results)}`,
  );
  assert.ok(
    results[highQualityIndex].score > results[lowQualityIndex].score,
    `expected higher score for better quality row:\n${printTopResults(results)}`,
  );
});

test("requested query set stays covered in the regression suite", async () => {
  const cases = [
    {
      query: "คพช",
      expectResult: (results) => {
        assert.equal(results[0]?.id, 102, `expected คพช row first:\n${printTopResults(results)}`);
      },
    },
    {
      query: "คณะกรรมการดำเนินการ",
      expectResult: (results) => {
        assert.ok(
          getResultIds(results).slice(0, 2).includes(101),
          `expected row 101 near the top:\n${printTopResults(results)}`,
        );
      },
    },
    {
      query: "เลิกสหกรณ์",
      expectResult: (results) => {
        assert.equal(results[0]?.id, 103, `expected dissolution row first:\n${printTopResults(results)}`);
      },
    },
    {
      query: "ชำระบัญชี",
      expectResult: (results) => {
        assert.ok(
          getResultIds(results).slice(0, 2).includes(103),
          `expected dissolution/accounting row in top results:\n${printTopResults(results)}`,
        );
      },
    },
    {
      query: "โครงสร้างของสหกรณ์",
      expectResult: (results) => {
        assert.equal(results[0]?.id, 105, `expected structure row first:\n${printTopResults(results)}`);
      },
    },
    {
      query: "นายทะเบียน",
      expectResult: (results) => {
        assert.ok(
          getResultIds(results).slice(0, 3).includes(104),
          `expected registrar row in top results:\n${printTopResults(results)}`,
        );
      },
    },
    {
      query: "สหกรณแหงชาติ",
      expectResult: (results) => {
        assert.ok(
          getResultIds(results).slice(0, 3).includes(102),
          `expected OCR-like typo to retrieve row 102:\n${printTopResults(results)}`,
        );
      },
    },
    {
      query: "กรรมการมีกี่คน",
      expectResult: (results) => {
        assert.ok(
          getResultIds(results).slice(0, 3).includes(111),
          `expected committee-count row in top results:\n${printTopResults(results)}`,
        );
      },
    },
    {
      query: "ประชาธิปไตยในสหกรณ์",
      expectResult: (results) => {
        assert.ok(
          getResultIds(results).slice(0, 3).includes(105),
          `expected democracy/structure row in top results:\n${printTopResults(results)}`,
        );
      },
    },
    {
      query: "ข้อมูลขยะ OCR",
      expectResult: (results) => {
        assert.ok(
          !getResultIds(results).includes(112),
          `garbage OCR row should be filtered out:\n${printTopResults(results)}`,
        );
      },
    },
  ];

  for (const entry of cases) {
    const results = await search(entry.query, 5);

    if (entry.query !== "ข้อมูลขยะ OCR") {
      assert.ok(results.length > 0, `expected results for query "${entry.query}"`);
    }

    entry.expectResult(results);
  }
});
