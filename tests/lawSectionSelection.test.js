const test = require("node:test");
const assert = require("node:assert/strict");

const { selectDatabaseOnlySources } = require("../services/sourceSelectionService");

test("database-only law-section selection keeps exact structured section ahead of nearby section suggestion", () => {
  const result = selectDatabaseOnlySources(
    {
      structured_laws: [
        {
          source: "tbl_laws",
          reference: "มาตรา 8",
          title: "วรรคแรก",
          content: "ทุนกลางของบรรดาสหกรณ์ไม่จำกัด",
          score: 500,
        },
      ],
      admin_knowledge: [],
      knowledge_suggestion: [
        {
          source: "knowledge_suggestion",
          reference: "มาตรา 89/3 พรบ.สหกรณ์ พ.ศ. 2542",
          title: "การสั่งเลิกสหกรณ์ออมทรัพย์หรือสหกรณ์เครดิตยูเนี่ยน",
          content: "นายทะเบียนสหกรณ์มีอำนาจสั่งเลิกตามมาตรา 89/3 วรรคสอง",
          score: 700,
        },
      ],
      vinichai: [],
      documents: [],
      pdf_chunks: [],
      knowledge_base: [],
      internet: [],
    },
    "law_section",
    {
      databaseOnlyMode: true,
      message: "มาตรา 8 พ.ร.บ. สหกรณ์",
      originalMessage: "มาตรา 8 พ.ร.บ. สหกรณ์",
      target: "coop",
      planCode: "free",
    },
  );

  assert.equal(result.selectedSources.length >= 1, true);
  assert.equal(result.selectedSources[0].reference, "มาตรา 8");
  assert.equal(result.selectedSources[0].source, "tbl_laws");
});

test("database-only law-section selection prioritizes group structured law when the query mentions กลุ่มเกษตรกร", () => {
  const result = selectDatabaseOnlySources(
    {
      structured_laws: [
        {
          source: "tbl_laws",
          reference: "ข้อ 6",
          title: "การถือหุ้น",
          content: "ข้อ 6 การถือหุ้นของสหกรณ์",
          score: 510,
        },
        {
          source: "tbl_glaws",
          reference: "ข้อ 6",
          title: "การถือหุ้น",
          content: "ข้อ 6 การถือหุ้นของกลุ่มเกษตรกร",
          score: 500,
        },
      ],
      admin_knowledge: [],
      knowledge_suggestion: [],
      vinichai: [],
      documents: [],
      pdf_chunks: [],
      knowledge_base: [],
      internet: [],
    },
    "law_section",
    {
      databaseOnlyMode: true,
      message: "ร่างข้อบังคับกลุ่มเกษตรกร ข้อ 6 การถือหุ้น",
      originalMessage: "ร่างข้อบังคับกลุ่มเกษตรกร ข้อ 6 การถือหุ้น",
      target: "all",
      planCode: "free",
    },
  );

  assert.equal(result.selectedSources.length >= 1, true);
  assert.equal(result.selectedSources[0].reference, "ข้อ 6");
  assert.equal(result.selectedSources[0].source, "tbl_glaws");
});
