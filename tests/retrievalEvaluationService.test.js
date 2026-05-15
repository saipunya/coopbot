const test = require("node:test");
const assert = require("node:assert/strict");

const { evaluateRetrievalResult } = require("../services/retrievalEvaluationService");

function evaluateSingleSource(message, source) {
  return evaluateRetrievalResult({
    message,
    effectiveMessage: message,
    questionIntent: "general",
    selectedSources: [source],
    databaseMatches: [source],
    internetMatches: [],
    usedInternetFallback: false,
    usedInternetSearch: false,
    resolvedContext: { usedContext: false, topicHints: [] },
  });
}

test("retrieval evaluation rejects sources that only match generic group terms", () => {
  const message = "ถ้าขออนุมัติวงเงินกู้ยืมกลุ่มเกษตรกร เกินกว่าเกณฑ์ทั่วไป";
  const result = evaluateSingleSource(message, {
    source: "tbl_glaws",
    score: 140,
    title: "การออกเสียงในที่ประชุมใหญ่ของกลุ่มเกษตรกร",
    content:
      "สมาชิกคนหนึ่งแม้จะถือหุ้นจำนวนเท่าใดก็ตาม ให้มีเสียงหนึ่งในการลงคะแนน " +
      "เว้นแต่การแก้ไขเพิ่มเติมข้อบังคับ การควบกลุ่มเกษตรกร และการเลิกกลุ่มเกษตรกร",
  });

  assert.equal(result.shouldAnswer, false);
  assert.equal(result.policy, "no_answer");
  assert.ok(result.reasonCodes.includes("semantic_mismatch"));
  assert.equal(result.metrics.semanticAligned, false);
  assert.deepEqual(result.metrics.semanticMatchedTerms, ["กลุ่ม", "เกษตรกร"]);
});

test("retrieval evaluation accepts a source that covers the group loan question", () => {
  const message = "ถ้าขออนุมัติวงเงินกู้ยืมกลุ่มเกษตรกร เกินกว่าเกณฑ์ทั่วไป";
  const result = evaluateSingleSource(message, {
    source: "admin_knowledge",
    score: 140,
    title: "กรณีขอวงเงินกู้ยืมเกินกว่าหลักเกณฑ์ทั่วไปของกลุ่มเกษตรกร",
    content:
      "กรณีขอวงเงินกู้ยืมเกินกว่าหลักเกณฑ์ทั่วไปของกลุ่มเกษตรกร " +
      "ต้องมีเหตุผลความจำเป็นและเอกสารประกอบตามประกาศวงเงินกู้ยืมของกลุ่มเกษตรกร",
  });

  assert.equal(result.shouldAnswer, true);
  assert.equal(result.policy, "answer");
  assert.ok(result.reasonCodes.includes("semantic_aligned"));
  assert.equal(result.metrics.semanticAligned, true);
  assert.ok(result.metrics.semanticCoverage >= 0.8);
});
