const assert = require("node:assert/strict");

const { rewriteSearchQuery } = require("../services/queryRewriteService");
const { evaluateRetrievalResult } = require("../services/retrievalEvaluationService");
const { getQueryFocusProfile } = require("../services/thaiTextUtils");

const QUESTIONS = [
  "ข้อบังคับกลุ่มเกษตรกร",
  "ข้อบังคับกลุ่มเกษตรกร ต้องมีอย่างไร",
  "ข้อบังคับกลุ่มเกษตรกร ต้องมีรายการอะไรบ้าง",
];

const REQUIRED_HINTS = [
  "ข้อบังคับกลุ่มเกษตรกร",
  "รายการที่ต้องมีในข้อบังคับกลุ่มเกษตรกร",
  "อย่างน้อยต้องมีรายการ",
];

const MOCK_SOURCE_TEXT = [
  "ข้อบังคับของกลุ่มเกษตรกร อย่างน้อยต้องมีรายการ ดังต่อไปนี้",
  "ชื่อ",
  "วัตถุประสงค์",
  "ที่ตั้งสำนักงาน",
  "ทุนซึ่งแบ่งเป็นหุ้น",
  "ข้อกำหนดเกี่ยวกับการประชุมใหญ่",
  "การเลือกตั้งผู้ตรวจสอบกิจการ",
  "อำนาจหน้าที่และความรับผิดชอบของผู้จัดการ",
].join(" ");

function runCheck(name, fn) {
  try {
    fn();
    console.log(`OK: ${name}`);
  } catch (error) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${error.message || error}`);
    process.exitCode = 1;
  }
}

function buildMockSources() {
  return [
    {
      source: "tbl_glaws",
      score: 118,
      title: "ข้อบังคับของกลุ่มเกษตรกร",
      reference: "พระราชกฤษฎีกาว่าด้วยกลุ่มเกษตรกร",
      content: MOCK_SOURCE_TEXT,
      rankingTrace: {
        focusAlignmentRaw: 42,
        matchedReference: "ข้อบังคับกลุ่มเกษตรกร",
      },
    },
    {
      source: "admin_knowledge",
      score: 96,
      title: "รายการที่ต้องมีในข้อบังคับกลุ่มเกษตรกร",
      content: MOCK_SOURCE_TEXT,
      rankingTrace: {
        focusAlignmentRaw: 36,
      },
    },
  ];
}

async function verifyQuestion(question) {
  const rewrite = await rewriteSearchQuery(question, {}, { allowAiRewrite: false });
  const focusProfile = getQueryFocusProfile(question);
  const sources = buildMockSources();
  const evaluation = evaluateRetrievalResult({
    message: question,
    effectiveMessage: rewrite.effectiveQuery,
    questionIntent: "general",
    selectedSources: sources,
    databaseMatches: sources,
    queryRewriteTrace: {
      method: rewrite.method,
      selectedType: "original",
      selectedQuery: rewrite.retrievalQuery,
      effectiveQuery: rewrite.effectiveQuery,
      summary: `expanded with ${(rewrite.expandedKeywords || []).slice(0, 2).join(", ")}`,
      ambiguousFollowUp: false,
      expandedKeywords: rewrite.expandedKeywords,
      legalAliases: rewrite.legalAliases,
    },
  });

  runCheck(`${question} maps to the expected topic`, () => {
    assert.ok(
      focusProfile.topics.some((topic) => topic.primary === "ข้อบังคับกลุ่มเกษตรกร"),
      "expected focus topic ข้อบังคับกลุ่มเกษตรกร",
    );
  });

  runCheck(`${question} receives bylaw-specific rewrite hints`, () => {
    const mergedHints = [
      rewrite.effectiveQuery,
      ...(rewrite.expandedKeywords || []),
      ...(rewrite.legalAliases || []),
      rewrite.retrievalQuery,
    ].join(" ");
    assert.ok(
      REQUIRED_HINTS.some((hint) => mergedHints.includes(hint)),
      `expected rewrite hints to include one of: ${REQUIRED_HINTS.join(", ")}`,
    );
  });

  runCheck(`${question} is answerable with aligned sources`, () => {
    assert.equal(evaluation.policy, "answer");
    assert.equal(evaluation.shouldAnswer, true);
    assert.ok(
      Number(evaluation.metrics.topFocusScore || 0) >= Number(evaluation.profile.minTopFocusScore || 0),
      "expected focus score to meet threshold",
    );
    assert.ok(Number(evaluation.answerabilityScore || 0) >= Number(evaluation.profile.minAnswerability || 0));
  });
}

async function main() {
  for (const question of QUESTIONS) {
    await verifyQuestion(question);
  }

  if (process.exitCode && process.exitCode !== 0) {
    throw new Error("group-bylaw verification failed");
  }

  console.log("Group-bylaw verification passed.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});