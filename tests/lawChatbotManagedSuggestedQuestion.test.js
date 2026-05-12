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
        answerText: [
          "ให้เสนอร่างแก้ไขต่อที่ประชุมและให้มติอนุมัติตามขั้นตอน",
          "",
          "แหล่งอ้างอิง:",
          "- คู่มือสหกรณ์",
        ].join("\n"),
        source: {
          id: 101,
          source: "managed_suggested_question",
          reference: "Q&A ผู้ดูแลระบบ",
          title: "การแก้ไขข้อบังคับบางข้อ",
          content: [
            "ให้เสนอร่างแก้ไขต่อที่ประชุมและให้มติอนุมัติตามขั้นตอน",
            "",
            "แหล่งอ้างอิง:",
            "- คู่มือสหกรณ์",
          ].join("\n"),
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
      ...require(rewritePath),
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
  const referenceIndex = result.answer.indexOf("แหล่งอ้างอิง:");
  if (referenceIndex !== -1) {
    assert.ok(result.answer.indexOf("ข้อมูลเพิ่มเติม") < referenceIndex);
    assert.doesNotMatch(result.answer.slice(referenceIndex), /ข้อมูลเพิ่มเติม|เพิ่มเติมจากข้อมูลอื่น/);
  }
  assert.doesNotMatch(result.answer, /เพิ่มเติมจากข้อมูลอื่น/);
  assert.equal(result.responseMeta?.answerMode, "db_only_main_chat");
  assert.ok(result.responseMeta?.sourceTables?.includes("chatbot_suggested_questions"));

  assert.equal(createdEntries.length, 2);
  assert.equal(createdEntries[0]?.matchedSources?.[0]?.source, "managed_suggested_question");
});

test("replyToChat does not append unrelated DB sources after a law-referenced Q&A answer", async (t) => {
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
        id: 119,
        questionText: "อำนาจหน้าที่ผู้ตรวจการสหกรณ์",
        answerText:
          "ให้ผู้ตรวจการสหกรณ์มีอำนาจหน้าที่ตรวจสอบกิจการและฐานะทางการเงินของสหกรณ์ ตามที่นายทะเบียนสหกรณ์กำหนด",
        source: {
          id: 119,
          source: "managed_suggested_question",
          reference: "มาตรา 19",
          title: "อำนาจหน้าที่ผู้ตรวจการสหกรณ์",
          content:
            "ให้ผู้ตรวจการสหกรณ์มีอำนาจหน้าที่ตรวจสอบกิจการและฐานะทางการเงินของสหกรณ์ ตามที่นายทะเบียนสหกรณ์กำหนด",
          score: 1000,
        },
      }),
      resolveSearchPlan: async () => ({
        effectiveMessage: "อำนาจหน้าที่ผู้ตรวจการสหกรณ์",
        resolvedContext: { usedContext: false, topicHints: [] },
        matches: [
          {
            id: 16,
            source: "tbl_laws",
            title: "มาตรา 16",
            reference: "มาตรา 16",
            lawNumber: "มาตรา 16",
            content:
              "บรรดาอำนาจของนายทะเบียนสหกรณ์ในการสั่ง อนุญาต อนุมัติ อาจมอบอำนาจให้ผู้ตรวจการสหกรณ์ปฏิบัติการแทนได้",
            score: 92,
          },
          {
            id: 9,
            source: "tbl_laws",
            title: "คณะกรรมการพัฒนาการสหกรณ์แห่งชาติ",
            reference: "มาตรา 9",
            lawNumber: "มาตรา 9",
            content: "ให้มีคณะกรรมการพัฒนาการสหกรณ์แห่งชาติ ประกอบด้วยกรรมการโดยตำแหน่ง",
            score: 80,
          },
        ],
        databaseMatches: [],
        internetMatches: [],
        questionIntent: "law_section",
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
        confidence: 0.95,
        answerNote: "",
        userFacingMessage: "",
      }),
    }),
  );

  restoreCallbacks.push(
    setMockedModule(rewritePath, {
      ...require(rewritePath),
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
      message: "อำนาจหน้าที่ผู้ตรวจการสหกรณ์",
      target: "coop",
    },
    {},
  );

  assert.match(result.answer, /ผู้ตรวจการสหกรณ์มีอำนาจหน้าที่ตรวจสอบกิจการ/);
  assert.doesNotMatch(result.answer, /ข้อมูลเพิ่มเติม/);
  assert.doesNotMatch(result.answer, /มอบอำนาจให้ผู้ตรวจการสหกรณ์ปฏิบัติการแทน/);
  assert.deepEqual(result.sourceReferences, ["Q&A ที่ผู้ดูแลเตรียมไว้ (chatbot_suggested_questions): มาตรา 19"]);
  assert.equal(result.continuation?.available, false);
  assert.equal(createdEntries[0]?.matchedSources?.length, 1);
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
      ...require(rewritePath),
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

test("FAQ short-circuit is skipped only when the question mentions มาตรา", () => {
  const { __private } = require("../services/lawChatbotService");
  const { getQueryFocusProfile } = require("../services/thaiTextUtils");

  assert.equal(__private.shouldSkipFaqForQuestion("มาตรา 75 ว่าอย่างไร"), true);
  assert.equal(__private.shouldSkipFaqForQuestion("ใครเป็นผู้มีอำนาจแต่งตั้งผู้ชำระบัญชี"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("ผู้ชำระบัญชีคือใคร"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("ผู้ชำระบัญชีคืออะไร"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("อำนาจหน้าที่ผู้ชำระบัญชี"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("อำนาจหน้าที่นายทะเบียนสหกรณ์"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("อำนาจหน้าที่คณะกรรมการดำเนินการ"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("ร่างข้อบังคับสหกรณ์ ข้อ 5"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("แก้ไขเพิ่มเติมข้อบังคับสหกรณ์"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("ขั้นตอนการแก้ไขเพิ่มเติมข้อบังคับสหกรณ์"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("การแก้ไขเพิ่มเติมข้อบังคับกลุ่มเกษตรกร"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("ขั้นตอนการจดทะเบียนแก้ไขข้อบังคับกลุ่มเกษตรกร"), false);
  assert.equal(__private.shouldSkipFaqForQuestion("สหกรณ์คืออะไร"), false);
  assert.equal(getQueryFocusProfile("การแก้ไขข้อบังคับบางข้อ").topics[0]?.primary, "แก้ไขเพิ่มเติมข้อบังคับสหกรณ์");
});

test("FAQ plus database composition omits duplicate additional text", () => {
  const { __private } = require("../services/lawChatbotService");

  const answer = __private.composeFaqAndDatabaseAnswer(
    "นายทะเบียนสหกรณ์มีอำนาจหน้าที่รับจดทะเบียน กำกับดูแล และออกคำสั่งตามกฎหมาย\n\nแหล่งอ้างอิง:\n- Q&A นายทะเบียน",
    "นายทะเบียนสหกรณ์มีอำนาจหน้าที่รับจดทะเบียน กำกับดูแล และออกคำสั่งตามกฎหมาย\n\nแหล่งอ้างอิง:\n- มาตรา 16",
  );

  assert.match(answer, /นายทะเบียนสหกรณ์มีอำนาจหน้าที่รับจดทะเบียน/);
  assert.doesNotMatch(answer, /ข้อมูลเพิ่มเติม/);
  assert.equal((answer.match(/นายทะเบียนสหกรณ์มีอำนาจหน้าที่รับจดทะเบียน/g) || []).length, 1);
});

test("FAQ duplicate database sources are removed from continuation pool", () => {
  const { __private } = require("../services/lawChatbotService");

  const sources = __private.removeDuplicateAnswerSourcesForContinuation(
    "นายทะเบียนสหกรณ์มีอำนาจหน้าที่รับจดทะเบียน กำกับดูแล และออกคำสั่งตามกฎหมาย",
    [
      {
        source: "tbl_laws",
        reference: "มาตรา 16",
        content: "นายทะเบียนสหกรณ์มีอำนาจหน้าที่รับจดทะเบียน กำกับดูแล และออกคำสั่งตามกฎหมาย",
      },
      {
        source: "tbl_laws",
        reference: "มาตรา 17",
        content: "นายทะเบียนสหกรณ์อาจมอบหมายให้รองนายทะเบียนสหกรณ์ปฏิบัติการแทนได้",
      },
    ],
  );

  assert.equal(sources.length, 1);
  assert.equal(sources[0]?.reference, "มาตรา 17");
});

test("continuation button requires renderable next content", async () => {
  const { __private } = require("../services/lawChatbotService");

  assert.equal(
    await __private.hasRenderableContinuationState({
      target: "coop",
      activeSourceIndex: 0,
      sources: [
        {
          source: "tbl_laws",
          id: "missing-record",
          content: "",
          continuationHasMore: true,
        },
      ],
    }),
    false,
  );

  assert.equal(
    await __private.hasRenderableContinuationState({
      target: "coop",
      activeSourceIndex: 0,
      sources: [
        {
          source: "custom",
          id: "source-1",
          content: "ข้อมูลเพิ่มเติมที่ควรแสดง",
          continuationHasMore: true,
        },
      ],
    }),
    true,
  );
});
