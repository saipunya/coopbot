const knowledgeDraftService = require("../services/knowledgeDraftService");

const ERROR_STATUS_BY_REASON = {
  admin_auth_required: 401,
  draft_not_found: 404,
  generation_failed: 500,
  invalid_payload: 400,
  invalid_source_id: 400,
  invalid_state: 409,
  not_saved: 500,
  not_updated: 500,
  retire_failed: 500,
  source_not_found: 404,
};

const ERROR_MESSAGE_BY_REASON = {
  admin_auth_required: "กรุณาเข้าสู่ระบบผู้ดูแลก่อนใช้งาน",
  draft_not_found: "ไม่พบร่างที่ต้องการจัดการ",
  generation_failed: "ไม่สามารถสร้างร่างจากแหล่งข้อมูลนี้ได้",
  invalid_payload: "ข้อมูลที่ส่งมาไม่ครบหรือไม่ถูกต้อง",
  invalid_source_id: "รหัสแหล่งข้อมูลไม่ถูกต้อง",
  invalid_state: "รายการนี้ไม่อยู่ในสถานะที่ทำรายการได้",
  not_saved: "ไม่สามารถบันทึกข้อมูลได้",
  not_updated: "ไม่สามารถอัปเดตข้อมูลได้",
  retire_failed: "ไม่สามารถยกเลิกร่างเดิมก่อนสร้างใหม่ได้",
  source_not_found: "ไม่พบแหล่งข้อมูลที่ต้องการ",
};

function normalizeId(value) {
  const normalized = Number(value || 0);
  return normalized > 0 ? normalized : null;
}

function pickText(...values) {
  for (const value of values) {
    const normalized = String(value || "").trim();
    if (normalized) {
      return normalized;
    }
  }

  return "";
}

function getAdminActor(req) {
  const adminUser = req?.session?.adminUser || {};
  return (
    String(adminUser.email || adminUser.username || adminUser.name || "admin")
      .trim() || "admin"
  );
}

function sendServiceResult(res, result, successStatus = 200) {
  if (result && result.ok) {
    return res.status(successStatus).json(result);
  }

  const reason = String(result?.reason || "unknown_error").trim();
  return res.status(ERROR_STATUS_BY_REASON[reason] || 500).json({
    ok: false,
    reason,
    message: ERROR_MESSAGE_BY_REASON[reason] || "ไม่สามารถดำเนินการได้",
    error: result?.error || null,
  });
}

async function createSource(req, res) {
  const title = pickText(req.body?.title, req.body?.name);
  const sourceText = pickText(
    req.body?.sourceText,
    req.body?.source_text,
    req.body?.source,
    req.body?.content,
  );

  if (!title || !sourceText) {
    return res.status(400).json({
      ok: false,
      reason: "invalid_payload",
      message: ERROR_MESSAGE_BY_REASON.invalid_payload,
    });
  }

  const result = await knowledgeDraftService.createKnowledgeSource({
    ...req.body,
    createdBy: getAdminActor(req),
  });

  return sendServiceResult(res, result, 201);
}

async function generateDrafts(req, res) {
  const sourceId = normalizeId(req.params.id);
  if (!sourceId) {
    return res.status(400).json({
      ok: false,
      reason: "invalid_source_id",
      message: ERROR_MESSAGE_BY_REASON.invalid_source_id,
    });
  }

  const result = await knowledgeDraftService.generateDraftsFromSource(sourceId, {
    forceRegenerate: req.body?.forceRegenerate,
    existingDraftLimit: req.body?.existingDraftLimit,
  });

  return sendServiceResult(res, result);
}

async function listDraftsBySource(req, res) {
  const sourceId = normalizeId(req.params.id);
  if (!sourceId) {
    return res.status(400).json({
      ok: false,
      reason: "invalid_source_id",
      message: ERROR_MESSAGE_BY_REASON.invalid_source_id,
    });
  }

  const result = await knowledgeDraftService.listDraftsBySourceId(sourceId, {
    status: req.query.status,
    limit: req.query.limit,
    offset: req.query.offset,
  });

  return sendServiceResult(res, result);
}

async function approveDraftToSuggestedQuestion(req, res) {
  const draftId = normalizeId(req.params.id);
  if (!draftId) {
    return res.status(400).json({
      ok: false,
      reason: "draft_not_found",
      message: ERROR_MESSAGE_BY_REASON.draft_not_found,
    });
  }

  const result = await knowledgeDraftService.approveDraftToSuggestedQuestion(draftId, req.body || {});
  return sendServiceResult(res, result);
}

async function approveDraftToKnowledge(req, res) {
  const draftId = normalizeId(req.params.id);
  if (!draftId) {
    return res.status(400).json({
      ok: false,
      reason: "draft_not_found",
      message: ERROR_MESSAGE_BY_REASON.draft_not_found,
    });
  }

  const result = await knowledgeDraftService.approveDraftToKnowledge(draftId, req.body || {});
  return sendServiceResult(res, result);
}

async function rejectDraft(req, res) {
  const draftId = normalizeId(req.params.id);
  if (!draftId) {
    return res.status(400).json({
      ok: false,
      reason: "draft_not_found",
      message: ERROR_MESSAGE_BY_REASON.draft_not_found,
    });
  }

  const result = await knowledgeDraftService.rejectDraft(draftId, req.body || {});
  return sendServiceResult(res, result);
}

module.exports = {
  approveDraftToKnowledge,
  approveDraftToSuggestedQuestion,
  createSource,
  generateDrafts,
  listDraftsBySource,
  rejectDraft,
};
