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

test("database-only source selection ranks coop formation evidence ahead of dissolution evidence", () => {
  const result = selectDatabaseOnlySources(
    {
      structured_laws: [
        {
          source: "tbl_laws",
          reference: "มาตรา 70",
          title: "การเลิกสหกรณ์",
          content:
            "สหกรณ์ย่อมเลิก เมื่อมีเหตุดังต่อไปนี้ นายทะเบียนสหกรณ์สั่งให้เลิกสหกรณ์",
          score: 900,
        },
        {
          source: "tbl_laws",
          reference: "มาตรา 33",
          title: "การจัดตั้งสหกรณ์",
          content:
            "สหกรณ์จะตั้งขึ้นได้โดยการจดทะเบียน และต้องมีผู้ซึ่งประสงค์จะเป็นสมาชิกเข้าชื่อกันไม่น้อยกว่าสิบคน",
          score: 700,
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
    "general",
    {
      databaseOnlyMode: true,
      message: "การจัดตั้งสหกรณ์",
      originalMessage: "การจัดตั้งสหกรณ์",
      target: "coop",
      planCode: "free",
    },
  );

  assert.equal(result.selectedSources.length >= 1, true);
  assert.equal(result.selectedSources[0].reference, "มาตรา 33");
});

test("database-only law-section selection prioritizes coop bylaw amendment over national committee source", () => {
  const result = selectDatabaseOnlySources(
    {
      structured_laws: [
        {
          source: "tbl_laws",
          reference: "มาตรา 10",
          title: "คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ",
          content:
            "ให้มีคณะกรรมการพัฒนาการสหกรณ์แห่งชาติ มีหน้าที่กำหนดนโยบายและแผนพัฒนาการสหกรณ์",
          score: 900,
        },
        {
          source: "tbl_laws",
          reference: "มาตรา 44",
          title: "การแก้ไขเพิ่มเติมข้อบังคับ",
          content:
            "การแก้ไขเพิ่มเติมข้อบังคับจะกระทำได้ก็แต่โดยมติของที่ประชุมใหญ่ และต้องนำข้อบังคับที่ได้แก้ไขเพิ่มเติมไปจดทะเบียนต่อนายทะเบียนสหกรณ์ภายในสามสิบวัน",
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
      message: "การแก้ไขเพิ่มเติมข้อบังคับสหกรณ์",
      originalMessage: "การแก้ไขเพิ่มเติมข้อบังคับสหกรณ์",
      target: "coop",
      planCode: "free",
    },
  );

  assert.equal(result.selectedSources.length >= 1, true);
  assert.equal(result.selectedSources[0].reference, "มาตรา 44");
});
