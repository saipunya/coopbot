const test = require("node:test");
const assert = require("node:assert/strict");

function loadFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(modulePath);
}

test("searchDatabaseSources prefers group-target knowledge and suggestions when the query mentions กลุ่มเกษตรกร", async () => {
  const LawChatbotKnowledgeModel = loadFresh("../models/lawChatbotKnowledgeModel");
  const LawChatbotKnowledgeSuggestionModel = loadFresh("../models/lawChatbotKnowledgeSuggestionModel");
  const { searchDatabaseSources } = loadFresh("../services/sourceSelectionService");

  await LawChatbotKnowledgeModel.create({
    target: "coop",
    title: "การถือหุ้นของสมาชิก",
    content: "ข้อ 6 การถือหุ้นของสหกรณ์",
    sourceNote: "ร่างข้อบังคับสหกรณ์ ข้อ 6 การถือหุ้น",
  });

  await LawChatbotKnowledgeModel.create({
    target: "group",
    title: "การถือหุ้นของสมาชิก",
    content: "ข้อ 6 การถือหุ้นของกลุ่มเกษตรกร",
    sourceNote: "ร่างข้อบังคับกลุ่มเกษตรกร ข้อ 6 การถือหุ้น",
  });

  await LawChatbotKnowledgeSuggestionModel.create({
    target: "coop",
    title: "การถือหุ้นของสมาชิก",
    content: "ข้อ 6 การถือหุ้นของสหกรณ์",
    sourceReference: "ร่างข้อบังคับสหกรณ์ ข้อ 6 การถือหุ้น",
    status: "approved",
  });

  await LawChatbotKnowledgeSuggestionModel.create({
    target: "group",
    title: "การถือหุ้นของสมาชิก",
    content: "ข้อ 6 การถือหุ้นของกลุ่มเกษตรกร",
    sourceReference: "ร่างข้อบังคับกลุ่มเกษตรกร ข้อ 6 การถือหุ้น",
    status: "approved",
  });

  const results = await searchDatabaseSources("การถือหุ้นของสมาชิกกลุ่มเกษตรกร", "all", {
    originalMessage: "การถือหุ้นของสมาชิกกลุ่มเกษตรกร",
    planCode: "free",
  });

  const adminKnowledgeResult = results.find((item) => item.source === "admin_knowledge");
  assert.ok(adminKnowledgeResult, "expected an admin knowledge result");
  assert.equal(adminKnowledgeResult.target, "group");
  assert.match(adminKnowledgeResult.content || "", /กลุ่มเกษตรกร/);

  const approvedSuggestionResult = results.find((item) => item.source === "knowledge_suggestion");
  assert.ok(approvedSuggestionResult, "expected an approved suggestion result");
  assert.equal(approvedSuggestionResult.target, "group");
  assert.match(approvedSuggestionResult.reference || "", /กลุ่มเกษตรกร/);
});
