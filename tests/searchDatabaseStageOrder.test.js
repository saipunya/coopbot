const test = require("node:test");
const assert = require("node:assert/strict");

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

test("searchDatabaseSources keeps exact Q&A subject when law search has no stronger hit", async () => {
  const KnowledgeModel = loadFresh("../models/lawChatbotKnowledgeModel");
  const SuggestedQuestionModel = loadFresh("../models/lawChatbotKnowledgeSuggestionModel");
  const LawSearchModel = loadFresh("../models/lawSearchModel");
  const { searchDatabaseSources } = loadFresh("../services/sourceSelectionService");

  const calls = [];
  KnowledgeModel.searchKnowledge = async (_message, _target, _limit, options = {}) => {
    calls.push(`knowledge:${options.searchMode || "full"}`);
    return options.searchMode === "subject"
      ? [
          {
            id: 1,
            source: "admin_knowledge",
            title: "ตั้งสหกรณ์",
            reference: "คู่มือการตั้งสหกรณ์",
            content: "",
            comment: "",
            score: 120,
          },
        ]
      : [];
  };
  SuggestedQuestionModel.searchApproved = async (_message, _target, _limit, options = {}) => {
    calls.push(`suggestion:${options.searchMode || "full"}`);
    return [];
  };
  LawSearchModel.searchStructuredLaws = async (_message, _target, _limit, options = {}) => {
    calls.push(`law:${options.searchMode || "full"}`);
    return [];
  };

  const results = await searchDatabaseSources("ตั้งสหกรณ์", "all", {
    originalMessage: "ตั้งสหกรณ์",
    planCode: "free",
  });

  assert.equal(results[0]?.source, "admin_knowledge");
  assert.equal(results.searchTrace?.selectedStage, "qa_subject");
  assert.equal(results.searchTrace?.comparedStage, "law_search");
  assert.equal(results.searchTrace?.fallbackUsed, false);
  assert.deepEqual(calls, ["knowledge:subject", "suggestion:subject", "law:keyword", "law:keyword"]);
});

test("searchDatabaseSources tries law keyword before Q&A content when subject search misses", async () => {
  const KnowledgeModel = loadFresh("../models/lawChatbotKnowledgeModel");
  const SuggestedQuestionModel = loadFresh("../models/lawChatbotKnowledgeSuggestionModel");
  const LawSearchModel = loadFresh("../models/lawSearchModel");
  const { searchDatabaseSources } = loadFresh("../services/sourceSelectionService");

  const calls = [];
  KnowledgeModel.searchKnowledge = async (_message, _target, _limit, options = {}) => {
    calls.push(`knowledge:${options.searchMode || "full"}`);
    return options.searchMode === "content"
      ? [
          {
            id: 2,
            source: "admin_knowledge",
            title: "คำอธิบายการตั้งสหกรณ์",
            reference: "คู่มือการตั้งสหกรณ์",
            content: "สมาชิกผู้ก่อการต้องเข้าชื่อกัน",
            comment: "",
            score: 110,
          },
        ]
      : [];
  };
  SuggestedQuestionModel.searchApproved = async (_message, _target, _limit, options = {}) => {
    calls.push(`suggestion:${options.searchMode || "full"}`);
    return [];
  };
  LawSearchModel.searchStructuredLaws = async (_message, _target, _limit, options = {}) => {
    calls.push(`law:${options.searchMode || "full"}`);
    return options.searchMode === "keyword"
      ? [
          {
            id: 3,
            source: "tbl_laws",
            title: "มาตรา 33",
            reference: "มาตรา 33",
            lawNumber: "33",
            content: "ผู้ซึ่งประสงค์จะเป็นสมาชิกเข้าชื่อกันไม่น้อยกว่า...",
            comment: "",
            score: 118,
          },
        ]
      : [];
  };

  const results = await searchDatabaseSources("ตั้งสหกรณ์", "all", {
    originalMessage: "ตั้งสหกรณ์",
    planCode: "free",
  });

  assert.equal(results[0]?.source, "tbl_laws");
  assert.equal(results.searchTrace?.selectedStage, "law_search");
  assert.ok(calls.includes("law:keyword"));
  assert.ok(calls.indexOf("law:keyword") >= 2);
  assert.ok(calls.slice(0, 2).every((call) => call.endsWith(":subject")));
  assert.ok(!calls.some((call) => call.endsWith(":content")));
});

test("searchDatabaseSources prefers exact law_search over broad Q&A subject token matches", async () => {
  const KnowledgeModel = loadFresh("../models/lawChatbotKnowledgeModel");
  const SuggestedQuestionModel = loadFresh("../models/lawChatbotKnowledgeSuggestionModel");
  const LawSearchModel = loadFresh("../models/lawSearchModel");
  const { searchDatabaseSources } = loadFresh("../services/sourceSelectionService");

  const calls = [];
  KnowledgeModel.searchKnowledge = async (_message, _target, _limit, options = {}) => {
    calls.push(`knowledge:${options.searchMode || "full"}`);
    return options.searchMode === "subject"
      ? [
          {
            id: 1,
            source: "admin_knowledge",
            title: "สหกรณ์มีกี่ประเภท อะไรบ้าง",
            reference: "การจัดตั้งสหกรณ์",
            content: "",
            comment: "",
            score: 229,
          },
        ]
      : [];
  };
  SuggestedQuestionModel.searchApproved = async (_message, _target, _limit, options = {}) => {
    calls.push(`suggestion:${options.searchMode || "full"}`);
    return [];
  };
  LawSearchModel.searchStructuredLaws = async (_message, _target, _limit, options = {}) => {
    calls.push(`law:${options.searchMode || "full"}`);
    return options.searchMode === "keyword"
      ? [
          {
            id: 60,
            source: "tbl_laws",
            title: "วรรคแรก",
            reference: "มาตรา 33",
            lawNumber: "มาตรา 33",
            content: "สหกรณ์จะตั้งขึ้นได้ โดยการจดทะเบียนตามพระราชบัญญัตินี้",
            comment: "ตั้งสหกรณ์ จัดตั้งสหกรณ์ จดทะเบียนจัดตั้ง",
            score: 546,
          },
        ]
      : [];
  };

  const results = await searchDatabaseSources("ตั้งสหกรณ์", "all", {
    originalMessage: "ตั้งสหกรณ์",
    planCode: "free",
  });

  assert.equal(results[0]?.source, "tbl_laws");
  assert.equal(results.searchTrace?.selectedStage, "law_search");
  assert.ok(calls.includes("law:keyword"));
  assert.ok(!calls.some((call) => call.endsWith(":content")));
});

test("searchDatabaseSources routes cooperative formation variants to sections 33 and 34", async () => {
  const KnowledgeModel = loadFresh("../models/lawChatbotKnowledgeModel");
  const SuggestedQuestionModel = loadFresh("../models/lawChatbotKnowledgeSuggestionModel");
  const LawSearchModel = loadFresh("../models/lawSearchModel");
  const { searchDatabaseSources } = loadFresh("../services/sourceSelectionService");

  KnowledgeModel.searchKnowledge = async (_message, _target, _limit, options = {}) =>
    options.searchMode === "subject"
      ? [
          {
            id: 10,
            source: "admin_knowledge",
            title: "การจัดตั้งสหกรณ์",
            reference: "Q&A ผู้ดูแลระบบ",
            content: "ข้อมูลทั่วไปเรื่องการจัดตั้งสหกรณ์",
            comment: "",
            score: 192,
          },
        ]
      : [];
  SuggestedQuestionModel.searchApproved = async () => [];
  LawSearchModel.searchStructuredLaws = async (_message, _target, _limit, options = {}) =>
    options.searchMode === "keyword"
      ? [
          {
            id: 60,
            source: "tbl_laws",
            title: "วรรคแรก",
            reference: "มาตรา 33",
            lawNumber: "มาตรา 33",
            content:
              "สหกรณ์จะตั้งขึ้นได้ โดยการจดทะเบียนตามพระราชบัญญัตินี้ และต้องมีวัตถุประสงค์ตามหลักการสหกรณ์",
            comment: "จัดตั้งสหกรณ์ จดทะเบียนจัดตั้งสหกรณ์",
            score: 998,
            topicExpansion: true,
          },
          {
            id: 64,
            source: "tbl_laws",
            title: "วรรคแรก",
            reference: "มาตรา 34",
            lawNumber: "มาตรา 34",
            content:
              "ผู้ซึ่งประสงค์จะเป็นสมาชิกต้องประชุมกันเพื่อคัดเลือกคณะผู้จัดตั้งสหกรณ์จำนวนไม่น้อยกว่าสิบคน",
            comment: "คณะผู้จัดตั้งสหกรณ์ ประชุมจัดตั้ง",
            score: 998,
            topicExpansion: true,
          },
        ]
      : [];

  for (const query of ["การจัดตั้งสหกรณ์", "ตั้งสหกรณ์", "จดทะเบียนจัดตั้งสหกรณ์"]) {
    const results = await searchDatabaseSources(query, "all", {
      originalMessage: query,
      planCode: "free",
    });

    assert.equal(results.searchTrace?.selectedStage, "law_search");
    assert.deepEqual(
      results.slice(0, 2).map((row) => row.reference),
      ["มาตรา 33", "มาตรา 34"],
    );
  }
});

test("searchDatabaseSources skips weak-focus Q&A stage and continues to focused law content", async () => {
  const KnowledgeModel = loadFresh("../models/lawChatbotKnowledgeModel");
  const SuggestedQuestionModel = loadFresh("../models/lawChatbotKnowledgeSuggestionModel");
  const LawSearchModel = loadFresh("../models/lawSearchModel");
  const { searchDatabaseSources } = loadFresh("../services/sourceSelectionService");

  const calls = [];
  KnowledgeModel.searchKnowledge = async (_message, _target, _limit, options = {}) => {
    calls.push(`knowledge:${options.searchMode || "full"}`);
    return options.searchMode === "subject"
      ? [
          {
            id: 9,
            source: "admin_knowledge",
            title: "สหกรณ์มีกี่ประเภท อะไรบ้าง",
            reference: "ประเภทสหกรณ์",
            content: "สหกรณ์มีหลายประเภท",
            comment: "",
            score: 160,
          },
        ]
      : [];
  };
  SuggestedQuestionModel.searchApproved = async (_message, _target, _limit, options = {}) => {
    calls.push(`suggestion:${options.searchMode || "full"}`);
    return [];
  };
  LawSearchModel.searchStructuredLaws = async (_message, _target, _limit, options = {}) => {
    calls.push(`law:${options.searchMode || "full"}`);
    return options.searchMode === "content"
      ? [
          {
            id: 44,
            source: "tbl_laws",
            title: "การแก้ไขเพิ่มเติมข้อบังคับ",
            reference: "มาตรา 44",
            lawNumber: "มาตรา 44",
            content:
              "การแก้ไขเพิ่มเติมข้อบังคับสหกรณ์ต้องได้รับมติที่ประชุมใหญ่และจดทะเบียนต่อนายทะเบียนสหกรณ์",
            comment: "แก้ไขข้อบังคับสหกรณ์ ที่ประชุมใหญ่ นายทะเบียนสหกรณ์",
            score: 132,
          },
        ]
      : [];
  };

  const results = await searchDatabaseSources("การแก้ไขข้อบังคับบางข้อ", "coop", {
    originalMessage: "การแก้ไขข้อบังคับบางข้อ",
    planCode: "free",
  });

  assert.equal(results[0]?.source, "tbl_laws");
  assert.equal(results.searchTrace?.selectedStage, "law_content");
  assert.equal(results.searchTrace?.stages?.[0]?.rejectedStageReason, "weak_focus_alignment");
  assert.ok(calls.some((call) => call === "law:content"));
});
