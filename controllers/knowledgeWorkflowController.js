const KnowledgeSourceModel = require("../models/knowledgeSourceModel");
const KnowledgeDraftModel = require("../models/knowledgeDraftModel");
const { pushFlashMessage } = require("../middlewares/flashMessageMiddleware");
const knowledgeDraftService = require("../services/knowledgeDraftService");

const WORKFLOW_DOMAIN_OPTIONS = [
  { value: "general", label: "ทั่วไป" },
  { value: "legal", label: "กฎหมาย" },
  { value: "mixed", label: "ผสม" },
];

const WORKFLOW_TARGET_OPTIONS = [
  { value: "general", label: "ทั่วไป" },
  { value: "all", label: "ทุกประเภท" },
  { value: "coop", label: "สหกรณ์" },
  { value: "group", label: "กลุ่มเกษตรกร" },
];

const WORKFLOW_SOURCE_STATUS_OPTIONS = [
  { value: "draft", label: "ร่าง" },
  { value: "approved", label: "อนุมัติแล้ว" },
  { value: "archived", label: "จัดเก็บแล้ว" },
];

const WORKFLOW_DRAFT_STATUS_OPTIONS = [
  { value: "draft", label: "ร่าง" },
  { value: "approved", label: "อนุมัติแล้ว" },
  { value: "rejected", label: "ปฏิเสธแล้ว" },
];

const WORKFLOW_APPROVED_RECORD_TYPE_OPTIONS = [
  { value: "knowledge", label: "ฐานความรู้" },
  { value: "suggested_question", label: "คำถามแนะนำ" },
];

const ERROR_STATUS_BY_REASON = {
  admin_auth_required: 401,
  invalid_draft_id: 400,
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
  invalid_draft_id: "รหัสร่างไม่ถูกต้อง",
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

function truncateText(value, limit = 220) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(1, limit - 1)).trim()}…`;
}

function labelFromOptions(options, value, fallback = "ไม่ระบุ") {
  const normalizedValue = String(value || "").trim().toLowerCase();
  const matched = options.find((item) => item.value === normalizedValue);
  return matched ? matched.label : fallback;
}

function getWorkflowDomainLabel(value) {
  return labelFromOptions(WORKFLOW_DOMAIN_OPTIONS, value, "ทั่วไป");
}

function getWorkflowTargetLabel(value) {
  return labelFromOptions(WORKFLOW_TARGET_OPTIONS, value, "ทั่วไป");
}

function getWorkflowSourceStatusLabel(value) {
  return labelFromOptions(WORKFLOW_SOURCE_STATUS_OPTIONS, value, "ร่าง");
}

function getWorkflowDraftStatusLabel(value) {
  return labelFromOptions(WORKFLOW_DRAFT_STATUS_OPTIONS, value, "ร่าง");
}

function getWorkflowApprovedRecordTypeLabel(value) {
  return labelFromOptions(WORKFLOW_APPROVED_RECORD_TYPE_OPTIONS, value, "ยังไม่เชื่อม");
}

function summarizeDrafts(drafts = []) {
  return drafts.reduce(
    (summary, draft) => {
      summary.total += 1;

      const status = String(draft?.status || "").trim().toLowerCase();
      if (status === "draft") {
        summary.draft += 1;
      } else if (status === "approved") {
        summary.approved += 1;
      } else if (status === "rejected") {
        summary.rejected += 1;
      }

      return summary;
    },
    {
      total: 0,
      draft: 0,
      approved: 0,
      rejected: 0,
    },
  );
}

function summarizeSources(sources = []) {
  return sources.reduce(
    (summary, source) => {
      summary.total += 1;

      const status = String(source?.status || "").trim().toLowerCase();
      if (status === "draft") {
        summary.draft += 1;
      } else if (status === "approved") {
        summary.approved += 1;
      } else if (status === "archived") {
        summary.archived += 1;
      }

      const draftSummary = source?.draftSummary || {};
      summary.draftTotal += Number(draftSummary.total || 0);
      summary.draftPending += Number(draftSummary.draft || 0);
      summary.draftApproved += Number(draftSummary.approved || 0);
      summary.draftRejected += Number(draftSummary.rejected || 0);

      return summary;
    },
    {
      total: 0,
      draft: 0,
      approved: 0,
      archived: 0,
      draftTotal: 0,
      draftPending: 0,
      draftApproved: 0,
      draftRejected: 0,
    },
  );
}

function buildWorkflowSourceRecord(source, drafts = []) {
  const draftSummary = summarizeDrafts(drafts);
  return {
    ...source,
    sourcePreviewText: truncateText(source?.sourceText || "", 260),
    domainLabel: getWorkflowDomainLabel(source?.domain),
    targetLabel: getWorkflowTargetLabel(source?.target),
    statusLabel: getWorkflowSourceStatusLabel(source?.status),
    draftSummary,
  };
}

function buildWorkflowDraftRecord(draft) {
  return {
    ...draft,
    statusLabel: getWorkflowDraftStatusLabel(draft?.status),
    approvedTargetLabel: getWorkflowTargetLabel(draft?.approvedTarget || "general"),
    approvedRecordTypeLabel: getWorkflowApprovedRecordTypeLabel(draft?.approvedRecordType),
  };
}

function flashAndRedirect(req, res, type, message, targetPath) {
  pushFlashMessage(req, type, message);
  return res.redirect(targetPath);
}

function getFlashMessageByReason(reason) {
  return ERROR_MESSAGE_BY_REASON[reason] || "ไม่สามารถดำเนินการได้";
}

function sendServiceResult(req, res, result, successStatus = 200, flashOptions = {}) {
  if (result && result.ok) {
    const successMessage =
      typeof flashOptions.successMessage === "function"
        ? flashOptions.successMessage(result)
        : flashOptions.successMessage;
    const successType =
      typeof flashOptions.successType === "function"
        ? flashOptions.successType(result)
        : flashOptions.successType;

    if (successMessage) {
      pushFlashMessage(req, successType || "success", successMessage);
    }

    return res.status(successStatus).json(result);
  }

  const reason = String(result?.reason || "unknown_error").trim();
  if (flashOptions.flashError !== false) {
    const errorMessage =
      typeof flashOptions.errorMessage === "function"
        ? flashOptions.errorMessage(result)
        : flashOptions.errorMessage || getFlashMessageByReason(reason);
    pushFlashMessage(req, flashOptions.errorType || "error", errorMessage);
  }

  return res.status(ERROR_STATUS_BY_REASON[reason] || 500).json({
    ok: false,
    reason,
    message: ERROR_MESSAGE_BY_REASON[reason] || "ไม่สามารถดำเนินการได้",
    error: result?.error || null,
  });
}

async function renderWorkflowIndex(req, res) {
  try {
    const recentSources = await KnowledgeSourceModel.listRecent(12);
    const recentSourcesWithDrafts = await Promise.all(
      recentSources.map(async (source) => {
        const drafts = await KnowledgeDraftModel.listBySourceId(source.id, {
          status: "all",
          limit: 500,
        });

        return buildWorkflowSourceRecord(source, drafts);
      }),
    );

    res.render("admin/knowledgeWorkflow", {
      title: "Knowledge Workflow",
      user: req.session.adminUser,
      pageErrorMessage: "",
      data: {
        recentSources: recentSourcesWithDrafts,
        summary: summarizeSources(recentSourcesWithDrafts),
      },
      domainOptions: WORKFLOW_DOMAIN_OPTIONS,
      targetOptions: WORKFLOW_TARGET_OPTIONS,
      sourceStatusOptions: WORKFLOW_SOURCE_STATUS_OPTIONS,
      draftStatusOptions: WORKFLOW_DRAFT_STATUS_OPTIONS,
      getWorkflowDomainLabel,
      getWorkflowTargetLabel,
      getWorkflowSourceStatusLabel,
      getWorkflowDraftStatusLabel,
      getWorkflowApprovedRecordTypeLabel,
    });
  } catch (error) {
    console.error("Failed to render knowledge workflow index:", error);
    res.status(500).render("admin/knowledgeWorkflow", {
      title: "Knowledge Workflow",
      user: req.session.adminUser,
      pageErrorMessage: "ไม่สามารถโหลดรายการ knowledge workflow ได้ในขณะนี้",
      data: {
        recentSources: [],
        summary: {
          total: 0,
          draft: 0,
          approved: 0,
          archived: 0,
          draftTotal: 0,
          draftPending: 0,
          draftApproved: 0,
          draftRejected: 0,
        },
      },
      domainOptions: WORKFLOW_DOMAIN_OPTIONS,
      targetOptions: WORKFLOW_TARGET_OPTIONS,
      sourceStatusOptions: WORKFLOW_SOURCE_STATUS_OPTIONS,
      draftStatusOptions: WORKFLOW_DRAFT_STATUS_OPTIONS,
      getWorkflowDomainLabel,
      getWorkflowTargetLabel,
      getWorkflowSourceStatusLabel,
      getWorkflowDraftStatusLabel,
      getWorkflowApprovedRecordTypeLabel,
    });
  }
}

async function submitWorkflow(req, res) {
  const title = pickText(req.body?.title, req.body?.name);
  const sourceText = pickText(
    req.body?.sourceText,
    req.body?.source_text,
    req.body?.source,
    req.body?.content,
  );

  if (!title || !sourceText) {
    return flashAndRedirect(
      req,
      res,
      "error",
      ERROR_MESSAGE_BY_REASON.invalid_payload,
      "/admin/knowledge-workflow",
    );
  }

  const createResult = await knowledgeDraftService.createKnowledgeSource({
    domain: req.body?.domain,
    target: req.body?.target,
    title,
    sourceText,
    sourceReference: req.body?.sourceReference || req.body?.source_reference,
    documentType: req.body?.documentType || req.body?.document_type,
    createdBy: getAdminActor(req),
  });

  if (!createResult.ok || !createResult.source) {
    return flashAndRedirect(
      req,
      res,
      "error",
      ERROR_MESSAGE_BY_REASON[createResult.reason] || ERROR_MESSAGE_BY_REASON.invalid_payload,
      "/admin/knowledge-workflow",
    );
  }

  const source = createResult.source;
  const detailPath = `/admin/knowledge-workflow/${source.id}`;
  const generateDraftsNow = normalizeBooleanFlag(req.body?.generateDraftsNow, false);

  if (!generateDraftsNow) {
    return flashAndRedirect(
      req,
      res,
      "info",
      `บันทึกต้นฉบับ "${source.title}" เรียบร้อยแล้ว`,
      detailPath,
    );
  }

  const generationResult = await knowledgeDraftService.generateDraftsFromSource(source.id, {
    forceRegenerate: false,
  });

  if (!generationResult.ok) {
    return flashAndRedirect(
      req,
      res,
      "error",
      ERROR_MESSAGE_BY_REASON[generationResult.reason] || ERROR_MESSAGE_BY_REASON.generation_failed,
      detailPath,
    );
  }

  const generatedCount = Array.isArray(generationResult.drafts) ? generationResult.drafts.length : 0;
  const flashType = generationResult.reusedExistingDrafts ? "info" : "success";
  const successMessage = generationResult.reusedExistingDrafts
    ? `บันทึกต้นฉบับ "${source.title}" เรียบร้อยแล้ว และใช้ draft เดิม`
    : `บันทึกต้นฉบับ "${source.title}" และสร้าง draft ${generatedCount} รายการเรียบร้อยแล้ว`;

  return flashAndRedirect(req, res, flashType, successMessage, detailPath);
}

async function renderWorkflowSourceDetail(req, res) {
  try {
    const sourceId = normalizeId(req.params.sourceId);
    if (!sourceId) {
      return res.status(400).render("admin/knowledgeWorkflowDetail", {
        title: "Knowledge Workflow",
        user: req.session.adminUser,
        pageErrorMessage: ERROR_MESSAGE_BY_REASON.invalid_source_id,
        data: {
          source: null,
          drafts: [],
          draftSummary: {
            total: 0,
            draft: 0,
            approved: 0,
            rejected: 0,
          },
        },
        domainOptions: WORKFLOW_DOMAIN_OPTIONS,
        targetOptions: WORKFLOW_TARGET_OPTIONS,
        sourceStatusOptions: WORKFLOW_SOURCE_STATUS_OPTIONS,
        draftStatusOptions: WORKFLOW_DRAFT_STATUS_OPTIONS,
        getWorkflowDomainLabel,
        getWorkflowTargetLabel,
        getWorkflowSourceStatusLabel,
        getWorkflowDraftStatusLabel,
        getWorkflowApprovedRecordTypeLabel,
      });
    }

    const source = await KnowledgeSourceModel.findById(sourceId);
    if (!source) {
      return res.status(404).render("admin/knowledgeWorkflowDetail", {
        title: "Knowledge Workflow",
        user: req.session.adminUser,
        pageErrorMessage: ERROR_MESSAGE_BY_REASON.source_not_found,
        data: {
          source: null,
          drafts: [],
          draftSummary: {
            total: 0,
            draft: 0,
            approved: 0,
            rejected: 0,
          },
        },
        domainOptions: WORKFLOW_DOMAIN_OPTIONS,
        targetOptions: WORKFLOW_TARGET_OPTIONS,
        sourceStatusOptions: WORKFLOW_SOURCE_STATUS_OPTIONS,
        draftStatusOptions: WORKFLOW_DRAFT_STATUS_OPTIONS,
        getWorkflowDomainLabel,
        getWorkflowTargetLabel,
        getWorkflowSourceStatusLabel,
        getWorkflowDraftStatusLabel,
        getWorkflowApprovedRecordTypeLabel,
      });
    }

    const drafts = await KnowledgeDraftModel.listBySourceId(source.id, {
      status: "all",
      limit: 500,
    });
    const draftRecords = drafts.map(buildWorkflowDraftRecord);
    const draftSummary = summarizeDrafts(draftRecords);

    res.render("admin/knowledgeWorkflowDetail", {
      title: `Knowledge Workflow - ${source.title}`,
      user: req.session.adminUser,
      pageErrorMessage: "",
      data: {
        source: {
          ...source,
          domainLabel: getWorkflowDomainLabel(source.domain),
          targetLabel: getWorkflowTargetLabel(source.target),
          statusLabel: getWorkflowSourceStatusLabel(source.status),
        },
        drafts: draftRecords,
        draftSummary,
      },
      domainOptions: WORKFLOW_DOMAIN_OPTIONS,
      targetOptions: WORKFLOW_TARGET_OPTIONS,
      sourceStatusOptions: WORKFLOW_SOURCE_STATUS_OPTIONS,
      draftStatusOptions: WORKFLOW_DRAFT_STATUS_OPTIONS,
      getWorkflowDomainLabel,
      getWorkflowTargetLabel,
      getWorkflowSourceStatusLabel,
      getWorkflowDraftStatusLabel,
      getWorkflowApprovedRecordTypeLabel,
    });
  } catch (error) {
    console.error("Failed to render knowledge workflow detail:", error);
    return res.status(500).render("admin/knowledgeWorkflowDetail", {
      title: "Knowledge Workflow",
      user: req.session.adminUser,
      pageErrorMessage: "ไม่สามารถโหลดรายละเอียด knowledge workflow ได้ในขณะนี้",
      data: {
        source: null,
        drafts: [],
        draftSummary: {
          total: 0,
          draft: 0,
          approved: 0,
          rejected: 0,
        },
      },
      domainOptions: WORKFLOW_DOMAIN_OPTIONS,
      targetOptions: WORKFLOW_TARGET_OPTIONS,
      sourceStatusOptions: WORKFLOW_SOURCE_STATUS_OPTIONS,
      draftStatusOptions: WORKFLOW_DRAFT_STATUS_OPTIONS,
      getWorkflowDomainLabel,
      getWorkflowTargetLabel,
      getWorkflowSourceStatusLabel,
      getWorkflowDraftStatusLabel,
      getWorkflowApprovedRecordTypeLabel,
    });
  }
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
    pushFlashMessage(req, "error", ERROR_MESSAGE_BY_REASON.invalid_payload);
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

  return sendServiceResult(req, res, result, 201, {
    successMessage: (serviceResult) =>
      `บันทึก knowledge source "${serviceResult.source?.title || title}" เรียบร้อยแล้ว`,
  });
}

async function generateDrafts(req, res) {
  const sourceId = normalizeId(req.params.id);
  if (!sourceId) {
    pushFlashMessage(req, "error", ERROR_MESSAGE_BY_REASON.invalid_source_id);
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

  return sendServiceResult(req, res, result, 200, {
    successMessage: (serviceResult) => {
      if (serviceResult.reusedExistingDrafts) {
        return "มี draft เดิมอยู่แล้ว ระบบจึงใช้ชุดเดิม";
      }

      const generatedCount = Array.isArray(serviceResult.drafts) ? serviceResult.drafts.length : 0;
      return serviceResult.regenerated
        ? `สร้าง draft ใหม่ ${generatedCount} รายการ และแทนที่ draft เดิมเรียบร้อยแล้ว`
        : `สร้าง draft ใหม่ ${generatedCount} รายการเรียบร้อยแล้ว`;
    },
    successType: (serviceResult) => (serviceResult.reusedExistingDrafts ? "info" : "success"),
  });
}

async function listDraftsBySource(req, res) {
  const sourceId = normalizeId(req.params.id);
  if (!sourceId) {
    pushFlashMessage(req, "error", ERROR_MESSAGE_BY_REASON.invalid_source_id);
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

  return sendServiceResult(req, res, result, 200, {
    flashError: false,
  });
}

async function approveDraftToSuggestedQuestion(req, res) {
  const draftId = normalizeId(req.params.id);
  if (!draftId) {
    pushFlashMessage(req, "error", ERROR_MESSAGE_BY_REASON.invalid_draft_id);
    return res.status(400).json({
      ok: false,
      reason: "invalid_draft_id",
      message: ERROR_MESSAGE_BY_REASON.invalid_draft_id,
    });
  }

  const result = await knowledgeDraftService.approveDraftToSuggestedQuestion(draftId, req.body || {});
  return sendServiceResult(req, res, result, 200, {
    successMessage: "อนุมัติ draft เป็นคำถามแนะนำเรียบร้อยแล้ว",
  });
}

async function approveDraftToKnowledge(req, res) {
  const draftId = normalizeId(req.params.id);
  if (!draftId) {
    pushFlashMessage(req, "error", ERROR_MESSAGE_BY_REASON.invalid_draft_id);
    return res.status(400).json({
      ok: false,
      reason: "invalid_draft_id",
      message: ERROR_MESSAGE_BY_REASON.invalid_draft_id,
    });
  }

  const result = await knowledgeDraftService.approveDraftToKnowledge(draftId, req.body || {});
  return sendServiceResult(req, res, result, 200, {
    successMessage: "อนุมัติ draft เป็นฐานความรู้เรียบร้อยแล้ว",
  });
}

async function rejectDraft(req, res) {
  const draftId = normalizeId(req.params.id);
  if (!draftId) {
    pushFlashMessage(req, "error", ERROR_MESSAGE_BY_REASON.invalid_draft_id);
    return res.status(400).json({
      ok: false,
      reason: "invalid_draft_id",
      message: ERROR_MESSAGE_BY_REASON.invalid_draft_id,
    });
  }

  const result = await knowledgeDraftService.rejectDraft(draftId, req.body || {});
  return sendServiceResult(req, res, result, 200, {
    successMessage: "ปฏิเสธ draft เรียบร้อยแล้ว",
  });
}

module.exports = {
  approveDraftToKnowledge,
  approveDraftToSuggestedQuestion,
  createSource,
  generateDrafts,
  listDraftsBySource,
  renderWorkflowIndex,
  renderWorkflowSourceDetail,
  rejectDraft,
  submitWorkflow,
};
