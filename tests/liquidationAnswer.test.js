const test = require("node:test");
const assert = require("node:assert/strict");

const RuntimeSettingModel = require("../models/runtimeSettingModel");
const { evaluateRetrievalResult } = require("../services/retrievalEvaluationService");
const { generateChatSummary } = require("../services/chatAnswerService");

function createLawSource({ lawNumber, content, score = 92 }) {
  return {
    source: "tbl_laws",
    id: `law-${lawNumber}`,
    lawNumber: String(lawNumber),
    reference: `มาตรา ${lawNumber}`,
    title: `มาตรา ${lawNumber}`,
    content,
    score,
  };
}

test("retrieval evaluation answers liquidation appointment query with strong section 75 evidence", () => {
  const message = "ใครเป็นผู้มีอำนาจแต่งตั้งผู้ชำระบัญชี";
  const selectedSources = [
    createLawSource({
      lawNumber: 75,
      content:
        "มาตรา 75 ในกรณีสหกรณ์เลิกด้วยเหตุอื่นนอกจากล้มละลาย ให้ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชีภายในสามสิบวันนับแต่วันที่เลิก และการตั้งผู้ชำระบัญชีต้องได้รับความเห็นชอบจากนายทะเบียนสหกรณ์ ถ้าที่ประชุมใหญ่ไม่เลือกตั้งหรือเลือกตั้งแล้วไม่ได้รับความเห็นชอบ ให้นายทะเบียนสหกรณ์มีอำนาจตั้งผู้ชำระบัญชี",
    }),
  ];

  const result = evaluateRetrievalResult({
    message,
    effectiveMessage: message,
    questionIntent: "law_section",
    selectedSources,
    databaseMatches: selectedSources,
    internetMatches: [],
    usedInternetFallback: false,
    usedInternetSearch: false,
    resolvedContext: { usedContext: false, topicHints: [] },
  });

  assert.equal(result.shouldAnswer, true);
  assert.equal(result.policy, "answer");
});

test("generateChatSummary gives a direct liquidation appointment answer", async () => {
  const originalFindByKey = RuntimeSettingModel.findByKey;
  RuntimeSettingModel.findByKey = async () => null;

  try {
    const message = "ใครเป็นผู้มีอำนาจแต่งตั้งผู้ชำระบัญชี";
    const summary = await generateChatSummary(
      message,
      [
        createLawSource({
          lawNumber: 75,
          content:
            "มาตรา 75 ในกรณีสหกรณ์เลิกด้วยเหตุอื่นนอกจากล้มละลาย ให้ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชีภายในสามสิบวันนับแต่วันที่เลิก และการตั้งผู้ชำระบัญชีต้องได้รับความเห็นชอบจากนายทะเบียนสหกรณ์ ถ้าที่ประชุมใหญ่ไม่เลือกตั้งหรือเลือกตั้งแล้วไม่ได้รับความเห็นชอบ ให้นายทะเบียนสหกรณ์มีอำนาจตั้งผู้ชำระบัญชี",
        }),
      ],
      {
        databaseOnlyMode: true,
        focusMessage: message,
        originalMessage: message,
        questionIntent: "law_section",
      },
    );

    assert.match(summary, /ที่ประชุมใหญ่/);
    assert.match(summary, /นายทะเบียนสหกรณ์/);
    assert.doesNotMatch(summary, /ยังไม่พบข้อมูลที่ตรงกับคำถามนี้/);
  } finally {
    RuntimeSettingModel.findByKey = originalFindByKey;
  }
});
