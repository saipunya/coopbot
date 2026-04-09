const KnowledgeSourceModel = require("../models/knowledgeSourceModel");
const KnowledgeDraftModel = require("../models/knowledgeDraftModel");
const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
const LawChatbotSuggestedQuestionModel = require("../models/lawChatbotSuggestedQuestionModel");
const { clearAnswerCache } = require("./answerStateService");
const { normalizeForSearch, segmentWords, uniqueTokens } = require("./thaiTextUtils");

const DRAFT_GENERIC_TOKENS = new Set([
  "การ",
  "เรื่อง",
  "เกี่ยวกับ",
  "ของ",
  "ใน",
  "ที่",
  "และ",
  "หรือ",
  "ตาม",
  "เพื่อ",
  "จาก",
  "โดย",
  "ให้",
  "ได้",
  "ไม่",
]);

const SOURCE_DOMAINS = new Set(["legal", "general", "mixed"]);
const SOURCE_TARGETS = new Set(["coop", "group", "all", "general"]);

function normalizeKnowledgeDomain(value, fallback = "general") {
  const normalized = String(value || "").trim().toLowerCase();
  return SOURCE_DOMAINS.has(normalized) ? normalized : fallback;
}

function normalizeKnowledgeTarget(value, fallback = "general") {
  const normalized = String(value || "").trim().toLowerCase();
  return SOURCE_TARGETS.has(normalized) ? normalized : fallback;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeBooleanFlag(value, fallback = false) {
  if (value === undefined || value === null) {
    return Boolean(fallback);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return Boolean(fallback);
  }

  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }

  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  return Boolean(value);
}

function extractKeywordsFromText(text, limit = 8) {
  return uniqueTokens(segmentWords(normalizeForSearch(String(text || "")).toLowerCase()))
    .map((token) => String(token || "").trim())
    .filter((token) => token && !DRAFT_GENERIC_TOKENS.has(token) && token.length >= 2)
    .slice(0, Math.max(1, Number(limit || 8)));
}

function buildFallbackDraftCandidate(source = {}) {
  const sourceText = normalizeText(source.sourceText || source.source_text);
  const title = normalizeText(source.title) || `แหล่งข้อมูล ${source.id}`;
  const summary = sourceText
    ? sourceText.replace(/\s+/g, " ").slice(0, 320).trim()
    : title;

  // This fallback keeps the pipeline usable until the AI generator is wired in.
  return {
    question: title,
    shortAnswer: summary,
    detailedAnswer: sourceText || summary,
    keywordsJson: JSON.stringify(extractKeywordsFromText(`${title} ${sourceText}`)),
    confidence: "medium",
    notes: `ร่างอัตโนมัติจากแหล่งข้อมูล ${source.id}`,
  };
}

function normalizeGeneratedDraftCandidate(candidate = {}, source = {}) {
  const sourceText = normalizeText(source.sourceText || source.source_text);
  const defaultSummary = sourceText
    ? sourceText.replace(/\s+/g, " ").slice(0, 320).trim()
    : normalizeText(source.title);

  const question = normalizeText(candidate.question || candidate.title) || normalizeText(source.title);
  const shortAnswer = normalizeText(
    candidate.shortAnswer || candidate.short_answer || candidate.answer || candidate.summary || defaultSummary,
  );
  const detailedAnswer = normalizeText(
    candidate.detailedAnswer || candidate.detailed_answer || sourceText || shortAnswer,
  );
  const keywordsSource =
    candidate.keywordsJson !== undefined
      ? candidate.keywordsJson
      : candidate.keywords_json !== undefined
        ? candidate.keywords_json
        : candidate.keywords !== undefined
          ? candidate.keywords
          : null;
  let keywordsJson = null;

  if (keywordsSource !== null && keywordsSource !== undefined) {
    if (Array.isArray(keywordsSource)) {
      keywordsJson = JSON.stringify(keywordsSource);
    } else if (typeof keywordsSource === "object") {
      keywordsJson = JSON.stringify(keywordsSource);
    } else {
      keywordsJson = normalizeText(keywordsSource);
    }
  }

  if (!keywordsJson) {
    keywordsJson = JSON.stringify(extractKeywordsFromText(`${question} ${shortAnswer} ${detailedAnswer}`));
  }

  return {
    question,
    shortAnswer,
    detailedAnswer,
    keywordsJson: normalizeText(keywordsJson),
    confidence: ["high", "medium", "low"].includes(String(candidate.confidence || "").trim().toLowerCase())
      ? String(candidate.confidence).trim().toLowerCase()
      : "medium",
    notes: normalizeText(candidate.notes || `ร่างจากแหล่งข้อมูล ${source.id}`),
  };
}

async function loadDraftContext(draftId) {
  const draft = await KnowledgeDraftModel.findById(draftId);
  if (!draft) {
    return { ok: false, reason: "draft_not_found" };
  }

  const source = await KnowledgeSourceModel.findById(draft.sourceId);
  if (!source) {
    return { ok: false, reason: "source_not_found" };
  }

  return { ok: true, draft, source };
}

async function createKnowledgeSource(payload = {}) {
  const source = await KnowledgeSourceModel.create({
    domain: payload.domain,
    target: payload.target,
    title: payload.title,
    sourceText: payload.sourceText || payload.source_text || payload.source || payload.content,
    normalizedText: payload.normalizedText || payload.normalized_text,
    sourceReference: payload.sourceReference || payload.source_reference || payload.reference,
    documentType: payload.documentType || payload.document_type,
    status: payload.status,
    createdBy: payload.createdBy || payload.created_by,
    approvedBy: payload.approvedBy || payload.approved_by,
    approvedAt: payload.approvedAt || payload.approved_at,
  });

  if (!source) {
    return { ok: false, reason: "invalid_payload" };
  }

  return { ok: true, source };
}

async function generateDraftsFromSource(sourceId, options = {}) {
  try {
    const source = await KnowledgeSourceModel.findById(sourceId);
    if (!source) {
      return { ok: false, reason: "source_not_found" };
    }

    const forceRegenerate = normalizeBooleanFlag(options.forceRegenerate, false);
    const existingDrafts = await KnowledgeDraftModel.listBySourceId(source.id, {
      status: "draft",
      limit: Math.max(1, Number(options.existingDraftLimit ?? 100)),
      offset: 0,
    });

    if (existingDrafts.length > 0 && !forceRegenerate) {
      return {
        ok: true,
        source,
        drafts: existingDrafts,
        reusedExistingDrafts: true,
        reused: true,
        generated: false,
        reason: "existing_drafts",
      };
    }

    const generator = typeof options.generator === "function" ? options.generator : null;
    let candidates = Array.isArray(options.drafts) ? options.drafts : null;

    if (!candidates && generator) {
      const generated = await generator(source, options);
      if (Array.isArray(generated)) {
        candidates = generated;
      } else if (generated && Array.isArray(generated.drafts)) {
        candidates = generated.drafts;
      } else if (generated) {
        candidates = [generated];
      }
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      candidates = [buildFallbackDraftCandidate(source)];
    }

    const retiredDraftIds = [];
    if (existingDrafts.length > 0 && forceRegenerate) {
      for (const existingDraft of existingDrafts) {
        const retired = await KnowledgeDraftModel.updateById(existingDraft.id, {
          status: "rejected",
          approvedTarget: null,
          approvedRecordType: null,
          approvedRecordId: null,
        });

        if (!retired) {
          return {
            ok: false,
            reason: "retire_failed",
            source,
            drafts: existingDrafts,
            retiredDraftIds,
          };
        }

        retiredDraftIds.push(existingDraft.id);
      }
    }

    const createdDrafts = [];
    for (const candidate of candidates) {
      const normalized = normalizeGeneratedDraftCandidate(candidate, source);
      if (!normalized.question || !normalized.shortAnswer) {
        continue;
      }

      const draft = await KnowledgeDraftModel.create({
        sourceId: source.id,
        question: normalized.question,
        shortAnswer: normalized.shortAnswer,
        detailedAnswer: normalized.detailedAnswer,
        keywordsJson: normalized.keywordsJson,
        confidence: normalized.confidence,
        notes: normalized.notes,
        status: "draft",
      });

      if (draft) {
        createdDrafts.push(draft);
      }
    }

    return {
      ok: true,
      source,
      drafts: createdDrafts,
      reusedExistingDrafts: false,
      reused: false,
      generated: true,
      regenerated: retiredDraftIds.length > 0,
      retiredDraftIds,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "generation_failed",
      error: error instanceof Error ? error.message : String(error || "unknown_error"),
    };
  }
}

async function listDraftsBySourceId(sourceId, options = {}) {
  const source = await KnowledgeSourceModel.findById(sourceId);
  if (!source) {
    return { ok: false, reason: "source_not_found" };
  }

  const drafts = await KnowledgeDraftModel.listBySourceId(source.id, {
    status: options.status,
    limit: options.limit,
    offset: options.offset,
  });

  return {
    ok: true,
    source,
    drafts,
  };
}

async function approveDraftToSuggestedQuestion(draftId, payload = {}) {
  const context = await loadDraftContext(draftId);
  if (!context.ok) {
    return context;
  }

  const { draft, source } = context;
  if (draft.status !== "draft") {
    return { ok: false, reason: "invalid_state" };
  }

  const domain = normalizeKnowledgeDomain(payload.domain || source.domain || "general");
  const target = normalizeKnowledgeTarget(payload.target || draft.approvedTarget || source.target || "general");
  const questionText = normalizeText(payload.questionText || payload.question || draft.question);
  const answerText = normalizeText(
    payload.answerText || payload.answer || draft.shortAnswer || draft.detailedAnswer || source.sourceText,
  );
  const sourceReference = normalizeText(
    payload.sourceReference || payload.reference || source.sourceReference || draft.notes,
  );

  const entry = await LawChatbotSuggestedQuestionModel.create({
    domain,
    target,
    questionText,
    answerText,
    sourceReference,
    sourceId: source.id,
    draftId: draft.id,
    displayOrder: Number(payload.displayOrder || 0) || 0,
    isActive: payload.isActive === false || payload.isActive === "false" || payload.isActive === "0" ? 0 : 1,
  });

  if (!entry) {
    return { ok: false, reason: "not_saved" };
  }

  const updated = await KnowledgeDraftModel.updateById(draft.id, {
    status: "approved",
    approvedTarget: target,
    approvedRecordType: "suggested_question",
    approvedRecordId: entry.id,
  });

  if (!updated) {
    await LawChatbotSuggestedQuestionModel.removeById(entry.id);
    return { ok: false, reason: "not_updated" };
  }

  clearAnswerCache();

  const refreshedDraft = await KnowledgeDraftModel.findById(draft.id);
  return {
    ok: true,
    source,
    draft: refreshedDraft,
    entry,
  };
}

async function approveDraftToKnowledge(draftId, payload = {}) {
  const context = await loadDraftContext(draftId);
  if (!context.ok) {
    return context;
  }

  const { draft, source } = context;
  if (draft.status !== "draft") {
    return { ok: false, reason: "invalid_state" };
  }

  const domain = normalizeKnowledgeDomain(payload.domain || source.domain || "general");
  const target = normalizeKnowledgeTarget(payload.target || draft.approvedTarget || source.target || "general");
  const title = normalizeText(payload.title || payload.question || draft.question || source.title);
  const lawNumber = normalizeText(payload.lawNumber || payload.law_number || "");
  const content = normalizeText(
    payload.content || payload.answer || draft.detailedAnswer || draft.shortAnswer || source.sourceText,
  );
  const sourceNote = normalizeText(
    payload.sourceNote || payload.source_note || source.sourceReference || draft.notes,
  );

  const entry = await LawChatbotKnowledgeModel.create({
    domain,
    target,
    title,
    lawNumber,
    content,
    sourceNote,
    sourceId: source.id,
    reviewStatus: payload.reviewStatus || payload.review_status || "approved",
  });

  if (!entry) {
    return { ok: false, reason: "not_saved" };
  }

  const updated = await KnowledgeDraftModel.updateById(draft.id, {
    status: "approved",
    approvedTarget: target,
    approvedRecordType: "knowledge",
    approvedRecordId: entry.id,
  });

  if (!updated) {
    await LawChatbotKnowledgeModel.removeById(entry.id);
    return { ok: false, reason: "not_updated" };
  }

  clearAnswerCache();

  const refreshedDraft = await KnowledgeDraftModel.findById(draft.id);
  return {
    ok: true,
    source,
    draft: refreshedDraft,
    entry,
  };
}

async function rejectDraft(draftId, payload = {}) {
  const context = await loadDraftContext(draftId);
  if (!context.ok) {
    return context;
  }

  const { draft } = context;
  if (draft.status !== "draft") {
    return { ok: false, reason: "invalid_state" };
  }

  const updated = await KnowledgeDraftModel.updateById(draft.id, {
    status: "rejected",
    approvedTarget: null,
    approvedRecordType: null,
    approvedRecordId: null,
    notes: normalizeText(payload.notes || payload.reviewNote || draft.notes),
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  const refreshedDraft = await KnowledgeDraftModel.findById(draft.id);
  return {
    ok: true,
    draft: refreshedDraft,
  };
}

module.exports = {
  approveDraftToKnowledge,
  approveDraftToSuggestedQuestion,
  createKnowledgeSource,
  generateDraftsFromSource,
  listDraftsBySourceId,
  rejectDraft,
};
