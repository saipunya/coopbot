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
  assert.equal(result.responseMeta?.answerMode, "managed_answer");
  assert.equal(result.responseMeta?.kind, "prepared_qa");
  assert.equal(result.responseMeta?.usesPreparedQa, true);
  assert.deepEqual(result.responseMeta?.sourceTables, ["chatbot_suggested_questions"]);
  assert.equal(result.continuation?.available, false);

  assert.equal(createdEntries.length, 1);
  assert.equal(createdEntries[0]?.matchedSources?.[0]?.source, "managed_suggested_question");
});
