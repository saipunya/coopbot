const test = require("node:test");
const assert = require("node:assert/strict");

function setMockedModule(modulePath, exportsValue) {
  const previous = require.cache[modulePath];
  require.cache[modulePath] = {
    id: modulePath,
    filename: modulePath,
    loaded: true,
    exports: exportsValue,
  };

  return () => {
    if (previous) {
      require.cache[modulePath] = previous;
      return;
    }

    delete require.cache[modulePath];
  };
}

test("replyToChat returns the saved managed Q&A answer before generic DB lookup", async (t) => {
  const servicePath = require.resolve("../services/lawChatbotService");
  const orchestrationPath = require.resolve("../services/chatOrchestrationService");
  const modelPath = require.resolve("../models/lawChatbotModel");

  const restoreCallbacks = [];
  const createdEntries = [];

  t.after(() => {
    delete require.cache[servicePath];
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore();
    }
  });

  delete require.cache[servicePath];

  const actualOrchestration = require(orchestrationPath);
  restoreCallbacks.push(
    setMockedModule(orchestrationPath, {
      ...actualOrchestration,
      findManagedSuggestedQuestionMatch: async () => ({
        id: 99,
        questionText: "สมาชิกลาออกต้องทำอย่างไร",
        answerText: "ยื่นใบลาออกเป็นหนังสือตามระเบียบของสหกรณ์",
        source: {
          id: 99,
          source: "managed_suggested_question",
          reference: "Q&A ผู้ดูแลระบบ",
          title: "สมาชิกลาออกต้องทำอย่างไร",
          content: "ยื่นใบลาออกเป็นหนังสือตามระเบียบของสหกรณ์",
          score: 1000,
        },
      }),
      recordUserSearchHistory: async () => {},
      resolveChatPlanContext: () => ({
        code: "free",
        promptProfile: { code: "template" },
      }),
    }),
  );

  restoreCallbacks.push(
    setMockedModule(modelPath, {
      create(payload) {
        createdEntries.push(payload);
      },
    }),
  );

  const lawChatbotService = require(servicePath);
  const result = await lawChatbotService.replyToChat(
    {
      message: "สมาชิกลาออกต้องทำอย่างไร",
      target: "coop",
    },
    {},
  );

  assert.match(result.answer, /ยื่นใบลาออกเป็นหนังสือตามระเบียบของสหกรณ์/);
  assert.equal(result.hasContext, true);
  assert.equal(result.responseMeta?.answerMode, "db_only_main_chat");
  assert.equal(result.responseMeta?.kind, "database_lookup");
  assert.equal(result.responseMeta?.usesPreparedQa, false);
  assert.ok(result.responseMeta?.sourceTables?.includes("chatbot_suggested_questions"));
  assert.equal(result.continuation?.available, false);

  assert.equal(createdEntries.length, 2);
  assert.equal(createdEntries[0]?.matchedSources?.[0]?.source, "managed_suggested_question");
});

test("replyToChat uses the saved Q&A answer first and appends DB explanation", async (t) => {
  const servicePath = require.resolve("../services/lawChatbotService");
  const orchestrationPath = require.resolve("../services/chatOrchestrationService");
  const retrievalPath = require.resolve("../services/retrievalEvaluationService");
  const rewritePath = require.resolve("../services/aiRewriteService");
  const searchLogPath = require.resolve("../services/searchLogService");
  const modelPath = require.resolve("../models/lawChatbotModel");

  const restoreCallbacks = [];
  const createdEntries = [];

  t.after(() => {
    delete require.cache[servicePath];
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore();
    }
  });

  delete require.cache[servicePath];

  const actualOrchestration = require(orchestrationPath);
  restoreCallbacks.push(
    setMockedModule(orchestrationPath, {
      ...actualOrchestration,
      findManagedSuggestedQuestionMatch: async () => ({
        id: 101,
        questionText: "การแก้ไขข้อบังคับบางข้อ",
        answerText: "ให้เสนอร่างแก้ไขต่อที่ประชุมและให้มติอนุมัติตามขั้นตอน",
        source: {
          id: 101,
          source: "managed_suggested_question",
          reference: "Q&A ผู้ดูแลระบบ",
          title: "การแก้ไขข้อบังคับบางข้อ",
          content: "ให้เสนอร่างแก้ไขต่อที่ประชุมและให้มติอนุมัติตามขั้นตอน",
          score: 1000,
        },
      }),
      resolveSearchPlan: async () => ({
        effectiveMessage: "การแก้ไขข้อบังคับบางข้อ",
        resolvedContext: { usedContext: false, topicHints: [] },
        matches: [
          {
            id: "db-1",
            source: "admin_knowledge",
            title: "แนวทางแก้ไขข้อบังคับ",
            reference: "คู่มือสหกรณ์",
            content: "ต้องจัดทำร่างแก้ไข แจ้งสมาชิก และดำเนินการตามมติที่ประชุม",
            score: 90,
          },
        ],
        databaseMatches: [],
        internetMatches: [],
        questionIntent: "general",
        selectionTrace: [],
        selectionDiagnostics: {},
      }),
      recordUserSearchHistory: async () => {},
      resolveChatPlanContext: () => ({
        code: "free",
        promptProfile: { code: "template" },
        sourceLimit: 5,
      }),
    }),
  );

  restoreCallbacks.push(
    setMockedModule(retrievalPath, {
      evaluateRetrievalResult: () => ({
        shouldAnswer: true,
        shouldReturnNoAnswer: false,
        confidence: 0.92,
        answerNote: "",
        userFacingMessage: "",
      }),
    }),
  );

  restoreCallbacks.push(
    setMockedModule(rewritePath, {
      rewriteLegalText: async (text) => text,
    }),
  );

  restoreCallbacks.push(
    setMockedModule(searchLogPath, {
      logSearchQuery: async () => {},
    }),
  );

  restoreCallbacks.push(
    setMockedModule(modelPath, {
      create(payload) {
        createdEntries.push(payload);
      },
    }),
  );

  const lawChatbotService = require(servicePath);
  const result = await lawChatbotService.replyToChat(
    {
      message: "การแก้ไขข้อบังคับบางข้อ",
      target: "coop",
    },
    {},
  );

  assert.match(result.answer, /^ให้เสนอร่างแก้ไขต่อที่ประชุมและให้มติอนุมัติตามขั้นตอน/);
  assert.match(result.answer, /ข้อมูลเพิ่มเติม/);
  assert.match(result.answer, /ต้องจัดทำร่างแก้ไข แจ้งสมาชิก และดำเนินการตามมติที่ประชุม/);
  assert.equal(result.responseMeta?.answerMode, "db_only_main_chat");
  assert.ok(result.responseMeta?.sourceTables?.includes("chatbot_suggested_questions"));

  assert.equal(createdEntries.length, 2);
  assert.equal(createdEntries[0]?.matchedSources?.[0]?.source, "managed_suggested_question");
});

test("replyToChat ignores unrelated FAQ matches for bylaw amendment questions", async (t) => {
  const servicePath = require.resolve("../services/lawChatbotService");
  const orchestrationPath = require.resolve("../services/chatOrchestrationService");
  const retrievalPath = require.resolve("../services/retrievalEvaluationService");
  const rewritePath = require.resolve("../services/aiRewriteService");
  const searchLogPath = require.resolve("../services/searchLogService");
  const modelPath = require.resolve("../models/lawChatbotModel");

  const restoreCallbacks = [];
  const createdEntries = [];

  t.after(() => {
    delete require.cache[servicePath];
    while (restoreCallbacks.length > 0) {
      const restore = restoreCallbacks.pop();
      restore();
    }
  });

  delete require.cache[servicePath];

  const actualOrchestration = require(orchestrationPath);
  restoreCallbacks.push(
    setMockedModule(orchestrationPath, {
      ...actualOrchestration,
      findManagedSuggestedQuestionMatch: async () => ({
        id: 202,
        questionText: "อำนาจของคณะกรรมการพัฒนาสหกรณ์แห่งชาติเป็นอย่างไร",
        answerText: "คณะกรรมการพัฒนาสหกรณ์แห่งชาติมีหน้าที่กำหนดนโยบายและแผนพัฒนาการสหกรณ์",
        source: {
          id: 202,
          source: "managed_suggested_question",
          reference: "Q&A ผู้ดูแลระบบ",
          title: "อำนาจของคณะกรรมการพัฒนาสหกรณ์แห่งชาติ",
          content: "คณะกรรมการพัฒนาสหกรณ์แห่งชาติมีหน้าที่กำหนดนโยบายและแผนพัฒนาการสหกรณ์",
          score: 1000,
        },
      }),
      resolveSearchPlan: async () => ({
        effectiveMessage: "การแก้ไขข้อบังคับบางข้อ",
        resolvedContext: { usedContext: false, topicHints: [] },
        matches: [
          {
            id: "db-2",
            source: "admin_knowledge",
            title: "แนวทางแก้ไขข้อบังคับ",
            reference: "คู่มือสหกรณ์",
            content: "ต้องเสนอต่อที่ประชุมใหญ่และดำเนินการจดทะเบียนแก้ไข",
            score: 90,
          },
        ],
        databaseMatches: [],
        internetMatches: [],
        questionIntent: "general",
        selectionTrace: [],
        selectionDiagnostics: {},
      }),
      recordUserSearchHistory: async () => {},
      resolveChatPlanContext: () => ({
        code: "free",
        promptProfile: { code: "template" },
        sourceLimit: 5,
      }),
    }),
  );

  restoreCallbacks.push(
    setMockedModule(retrievalPath, {
      evaluateRetrievalResult: () => ({
        shouldAnswer: true,
        shouldReturnNoAnswer: false,
        confidence: 0.92,
        answerNote: "",
        userFacingMessage: "",
      }),
    }),
  );

  restoreCallbacks.push(
    setMockedModule(rewritePath, {
      rewriteLegalText: async (text) => text,
    }),
  );

  restoreCallbacks.push(
    setMockedModule(searchLogPath, {
      logSearchQuery: async () => {},
    }),
  );

  restoreCallbacks.push(
    setMockedModule(modelPath, {
      create(payload) {
        createdEntries.push(payload);
      },
    }),
  );

  const lawChatbotService = require(servicePath);
  const result = await lawChatbotService.replyToChat(
    {
      message: "การแก้ไขข้อบังคับบางข้อ",
      target: "coop",
    },
    {},
  );

  assert.match(result.answer, /ต้องเสนอต่อที่ประชุมใหญ่และดำเนินการจดทะเบียนแก้ไข/);
  assert.doesNotMatch(result.answer, /คณะกรรมการพัฒนาสหกรณ์แห่งชาติ/);
  assert.equal(result.responseMeta?.answerMode, "db_only_main_chat");
  assert.equal(createdEntries.length, 1);
  assert.equal(createdEntries[0]?.matchedSources?.[0]?.source, "admin_knowledge");
});

test("FAQ short-circuit is skipped for specific law questions", () => {
  const { __private } = require("../services/lawChatbotService");
  const { getQueryFocusProfile } = require("../services/thaiTextUtils");

  assert.equal(__private.shouldSkipFaqForQuestion("มาตรา 75 ว่าอย่างไร"), true);
  assert.equal(__private.shouldSkipFaqForQuestion("ใครเป็นผู้มีอำนาจแต่งตั้งผู้ชำระบัญชี"), true);
  assert.equal(__private.shouldSkipFaqForQuestion("ผู้ชำระบัญชีคือใคร"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("ผู้ชำระบัญชีคืออะไร"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("แก้ไขเพิ่มเติมข้อบังคับสหกรณ์"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("ขั้นตอนการแก้ไขเพิ่มเติมข้อบังคับสหกรณ์"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("การแก้ไขเพิ่มเติมข้อบังคับกลุ่มเกษตรกร"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("ขั้นตอนการจดทะเบียนแก้ไขข้อบังคับกลุ่มเกษตรกร"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("สหกรณ์คืออะไร"), false);
  assert.equal(getQueryFocusProfile("การแก้ไขข้อบังคับบางข้อ").topics[0]?.primary, "แก้ไขเพิ่มเติมข้อบังคับสหกรณ์");
});
