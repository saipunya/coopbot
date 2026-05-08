const { generateOpenAiCompletion } = require("./openAiService");
const { recordAiRewriteCall } = require("./aiUsageStatsService");

const AI_REWRITE_MODEL = process.env.OPENAI_AI_REWRITE_MODEL || "gpt-5.4-mini";
const AI_REWRITE_INPUT_LIMIT = Number(process.env.AI_REWRITE_INPUT_LIMIT || 600);
const AI_REWRITE_MIN_LENGTH = Number(process.env.AI_REWRITE_MIN_LENGTH || 200);

const AI_REWRITE_PROMPT =
  "อธิบายข้อความกฎหมายนี้ให้เข้าใจง่าย กระชับ และไม่เพิ่มข้อมูล:\n";

function limitRewriteInput(text = "") {
  return String(text || "").trim().slice(0, AI_REWRITE_INPUT_LIMIT);
}

function shouldRewriteAnswer(rawAnswer = "", options = {}) {
  const answer = String(rawAnswer || "").trim();

  if (answer.length <= AI_REWRITE_MIN_LENGTH) {
    return false;
  }

  if (options.explicitLawSectionQuery === true) {
    return false;
  }

  return true;
}

function splitAnswerReferenceSection(answer = "") {
  const rawAnswer = String(answer || "");
  const referenceMatch = rawAnswer.match(/(\n\s*\n?\s*(?:แหล่งอ้างอิง|อ้างอิง)\s*[:：][\s\S]*)$/u);
  if (!referenceMatch) {
    return {
      mainText: rawAnswer.trim(),
      referenceText: "",
    };
  }

  const referenceText = String(referenceMatch[1] || "").trim();
  const mainText = rawAnswer.slice(0, rawAnswer.length - referenceMatch[1].length).trim();

  return {
    mainText,
    referenceText,
  };
}

function stripReferenceSection(answer = "") {
  return splitAnswerReferenceSection(answer).mainText;
}

async function rewriteLegalText(rawAnswer = "", options = {}) {
  if (!shouldRewriteAnswer(rawAnswer, options)) {
    return "";
  }

  const text = limitRewriteInput(stripReferenceSection(rawAnswer));
  if (!text) {
    return "";
  }

  try {
    const rewritten = await generateOpenAiCompletion({
      model: AI_REWRITE_MODEL,
      userContent: `${AI_REWRITE_PROMPT}${text}`,
    });

    if (rewritten) {
      await recordAiRewriteCall("success");
    }

    return rewritten;
  } catch (error) {
    await recordAiRewriteCall("failure");
    console.error("[aiRewriteService] rewrite failed:", error.message);
    return "";
  }
}

module.exports = {
  rewriteLegalText,
  shouldRewriteAnswer,
  limitRewriteInput,
  splitAnswerReferenceSection,
  stripReferenceSection,
};
