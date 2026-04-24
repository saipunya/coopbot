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

function evaluateSources({ message, questionIntent = "general", selectedSources = [] }) {
  return evaluateRetrievalResult({
    message,
    effectiveMessage: message,
    questionIntent,
    selectedSources,
    databaseMatches: selectedSources,
    internetMatches: [],
    usedInternetFallback: false,
    usedInternetSearch: false,
    resolvedContext: { usedContext: false, topicHints: [] },
  });
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

test("retrieval confidence high answers directly without note", () => {
  const message = "ใครเป็นผู้มีอำนาจแต่งตั้งผู้ชำระบัญชี";
  const result = evaluateSources({
    message,
    questionIntent: "law_section",
    selectedSources: [
      createLawSource({
        lawNumber: 75,
        score: 150,
        content:
          "มาตรา 75 การเลิกสหกรณ์และการชำระบัญชี ให้ที่ประชุมใหญ่เลือกตั้งผู้ชำระบัญชี และต้องได้รับความเห็นชอบจากนายทะเบียนสหกรณ์ หากไม่เลือกตั้งให้นายทะเบียนสหกรณ์มีอำนาจตั้งผู้ชำระบัญชี",
      }),
    ],
  });

  assert.equal(result.shouldAnswer, true);
  assert.equal(result.policy, "answer");
  assert.equal(result.confidenceLevel, "high");
  assert.equal(result.answerNote, "");
});

test("retrieval confidence medium answers with found-data note", () => {
  const message = "การเลิกสหกรณ์ทำอย่างไร";
  const result = evaluateSources({
    message,
    selectedSources: [
      {
        source: "admin_knowledge",
        id: "knowledge-liquidation",
        reference: "การเลิกสหกรณ์",
        title: "การเลิกสหกรณ์",
        content: "การเลิกสหกรณ์ ชำระบัญชี ผู้ชำระบัญชี นายทะเบียนสหกรณ์",
        score: 120,
      },
    ],
  });

  assert.equal(result.shouldAnswer, true);
  assert.equal(result.policy, "answer");
  assert.equal(result.confidenceLevel, "medium");
  assert.equal(result.answerNote, "อ้างอิงจากข้อมูลที่พบ");
});

test("retrieval confidence low returns no-answer instead of guessing", () => {
  const message = "ผู้ชำระบัญชีคืออะไร";
  const result = evaluateSources({
    message,
    selectedSources: [
      {
        source: "pdf_chunks",
        id: "weak-pdf-chunk",
        title: "เอกสารทั่วไป",
        content: "เอกสารทั่วไป สหกรณ์",
        score: 45,
      },
    ],
  });

  assert.equal(result.shouldAnswer, false);
  assert.equal(result.policy, "no_answer");
  assert.equal(result.shouldReturnNoAnswer, true);
  assert.equal(result.confidenceLevel, "low");
  assert.equal(result.answerNote, "");
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
