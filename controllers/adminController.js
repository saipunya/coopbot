const lawChatbotService = require("../services/lawChatbotService");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const { loginAdmin } = require("../services/adminAuthService");
const {
  createGoogleAuthUrl,
  getGoogleConfig,
  loginWithGoogleCallback,
} = require("../services/adminGoogleAuthService");
const { hasAcceptedLawChatbotNotice } = require("../middlewares/authMiddleware");
const runtimeSettingsService = require("../services/runtimeSettingsService");
const vinichaiAdminService = require("../services/vinichaiAdminService");
const {
  generateKeywordFromChunk,
  normalizeChunkText,
  splitIntoKnowledgeChunks,
} = require("../utils/chunkSplitter");

function appendQueryParam(path, key, value) {
  const normalizedPath = String(path || "").trim();
  const normalizedKey = String(key || "").trim();
  const hashIndex = normalizedPath.indexOf("#");
  const basePath = hashIndex >= 0 ? normalizedPath.slice(0, hashIndex) : normalizedPath;
  const hash = hashIndex >= 0 ? normalizedPath.slice(hashIndex) : "";
  const separator = basePath.includes("?") ? "&" : "?";
  return `${basePath}${separator}${encodeURIComponent(normalizedKey)}=${encodeURIComponent(String(value || ""))}${hash}`;
}

function sanitizePaymentRequestReturnPath(value, fallbackPath = "/admin/payment-requests") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!path.startsWith("/admin/payment-requests")) {
    return fallbackPath;
  }

  return path;
}

function sanitizeVinichaiReturnPath(value, fallbackPath = "/admin/vinichai") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!/^\/admin\/vinichai(?:[?#].*)?$/.test(path)) {
    return fallbackPath;
  }

  return path;
}

function sanitizeAdminUsersReturnPath(value, fallbackPath = "/admin/users") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!path.startsWith("/admin/users")) {
    return fallbackPath;
  }

  return path;
}

function sanitizeGuestUsageReturnPath(value, fallbackPath = "/admin/guest-usage") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!path.startsWith("/admin/guest-usage")) {
    return fallbackPath;
  }

  return path;
}

function sanitizeDashboardReturnPath(value, fallbackPath = "/admin") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!/^\/admin(?:[?#].*)?$/.test(path)) {
    return fallbackPath;
  }

  return path;
}

function sanitizeKnowledgeAdminReturnPath(value, fallbackPath = "/admin") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!/^\/admin(?:\/(?:suggested-questions|knowledge|knowledge-suggestions))?(?:[?#].*)?$/.test(path)) {
    return fallbackPath;
  }

  return path;
}

function sanitizePdfChunkAdminReturnPath(value, fallbackPath = "/admin/pdf-chunks/manual") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!/^\/admin\/pdf-chunks\/manual(?:[?#].*)?$/.test(path)) {
    return fallbackPath;
  }

  return path;
}

function deriveManualChunkKeyword(baseKeyword, block, index, totalBlocks) {
  return (
    generateKeywordFromChunk(block, {
      baseKeyword,
      topic: baseKeyword,
      index,
      totalChunks: totalBlocks,
    }) || String(baseKeyword || "").trim().slice(0, 255)
  );
}

function splitManualChunkText(baseKeyword, rawContent, splitMode = "single") {
  const normalizedText = normalizeChunkText(rawContent);
  if (!normalizedText) {
    return [];
  }

  if (splitMode !== "auto") {
    return [
      {
        keyword: String(baseKeyword || "").trim().slice(0, 255),
        chunkText: normalizedText,
      },
    ];
  }

  const chunks = splitIntoKnowledgeChunks(normalizedText, {
    baseKeyword,
    topic: baseKeyword,
    minLength: 80,
    maxLength: 350,
    targetLength: 220,
  });

  if (chunks.length === 0) {
    return [
      {
        keyword: String(baseKeyword || "").trim().slice(0, 255),
        chunkText: normalizedText,
      },
    ];
  }

  return chunks.map((chunk, index) => ({
    keyword: chunk.keyword || deriveManualChunkKeyword(baseKeyword, chunk.chunkText, index, chunks.length),
    chunkText: chunk.chunkText,
    cleanText: chunk.cleanText,
  }));
}

function sanitizePublicUserReturnPath(value, fallbackPath = "/law-chatbot") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!/^(?:\/law-chatbot(?:[/?#].*)?|\/user(?:[/?#].*)?)$/.test(path)) {
    return fallbackPath;
  }

  return path;
}

function renderLogin(req, res) {
  res.render("admin/login", {
    title: "เข้าสู่ระบบผู้ดูแล",
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    googleLoginEnabled: getGoogleConfig().enabled,
  });
}

async function submitLogin(req, res) {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  let result;

  try {
    result = await loginAdmin(username, password);
  } catch (error) {
    return res.redirect(
      "/admin/login?error=" +
        encodeURIComponent("ระบบฐานข้อมูลยังไม่พร้อมสำหรับการเข้าสู่ระบบผู้ดูแล")
    );
  }

  if (!result.ok) {
    return res.redirect(
      "/admin/login?error=" + encodeURIComponent(result.message)
    );
  }

  delete req.session.user;
  delete req.session.googleOAuthState;
  delete req.session.googleOAuthReturnTo;
  req.session.adminUser = result.user;
  return res.redirect("/admin");
}

function redirectToGoogleLogin(req, res) {
  try {
    const authUrl = createGoogleAuthUrl(req);

    req.session.save((err) => {
      if (err) {
        console.error("Failed to save session before Google redirect:", err);
        return res.redirect(
          "/admin/login?error=" +
            encodeURIComponent("ไม่สามารถเริ่มต้นการเข้าสู่ระบบด้วย Google ได้")
        );
      }

      return res.redirect(authUrl);
    });
  } catch (error) {
    console.error("Google login redirect error:", error);
    return res.redirect(
      "/admin/login?error=" +
        encodeURIComponent("Google Login ยังไม่ได้ตั้งค่าในระบบ")
    );
  }
}

function saveSessionAndRedirect(req, res, targetPath, errorMessage, logLabel) {
  req.session.save((error) => {
    if (error) {
      console.error(logLabel, error);
      return res.redirect(
        "/admin/login?error=" + encodeURIComponent(errorMessage)
      );
    }

    return res.redirect(targetPath);
  });
}

async function handleGoogleCallback(req, res) {
  if (req.query.error) {
    return res.redirect(
      "/admin/login?error=" +
        encodeURIComponent("การเข้าสู่ระบบด้วย Google ถูกยกเลิกหรือไม่สำเร็จ")
    );
  }

  try {
    const result = await loginWithGoogleCallback(req);
    req.session.user = result.user;
    delete req.session.adminUser;
    delete req.session.googleOAuthReturnTo;
    return saveSessionAndRedirect(
      req,
      res,
      result.returnTo || "/user",
      "ไม่สามารถบันทึกสถานะการเข้าสู่ระบบด้วย Google ได้",
      "Failed to save session after Google callback:"
    );
  } catch (error) {
    console.error("Google callback error:", error.message);
    return res.redirect(
      "/admin/login?error=" +
        encodeURIComponent(error.message || "ไม่สามารถเข้าสู่ระบบด้วย Google ได้")
    );
  }
}

async function renderDashboard(req, res) {
  const [uploadData, feedbackData, knowledgeData, paymentRequestData, aiSettings] = await Promise.all([
    lawChatbotService.getUploadPageData(),
    lawChatbotService.getFeedbackPageData(),
    lawChatbotService.getKnowledgeAdminSummaryData(),
    lawChatbotService.getAdminPaymentRequestsData({ page: 1 }),
    runtimeSettingsService.getAiAdminState(),
  ]);

  res.render("admin/dashboard", {
    title: "Admin Dashboard",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    uploadData,
    feedbackData,
    knowledgeData,
    paymentRequestData,
    aiSettings,
    dashboardReturnPath: req.originalUrl || "/admin",
  });
}

async function renderSuggestedQuestions(req, res) {
  const data = await lawChatbotService.getKnowledgeAdminData({
    sqPage: req.query.page || 1,
    sqPerPage: req.query.perPage || 12,
  });

  res.render("admin/suggestedQuestions", {
    title: "Suggested Questions",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
    returnPath: req.originalUrl || "/admin/suggested-questions",
  });
}

async function renderKnowledge(req, res) {
  const data = await lawChatbotService.getKnowledgeAdminData({
    knowledgePage: req.query.page || 1,
    knowledgePerPage: req.query.perPage || 12,
  });

  res.render("admin/knowledge", {
    title: "Knowledge Management",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
    returnPath: req.originalUrl || "/admin/knowledge",
  });
}

async function renderKnowledgeSuggestions(req, res) {
  const data = await lawChatbotService.getKnowledgeAdminData({
    pendingPage: req.query.page || 1,
    pendingPerPage: req.query.perPage || 12,
    pendingSourceType: req.query.sourceType || "all",
  });

  res.render("admin/knowledgeSuggestions", {
    title: "Knowledge Suggestions",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
    returnPath: req.originalUrl || "/admin/knowledge-suggestions",
  });
}

async function renderManualPdfChunks(req, res) {
  const chunkCount = await LawChatbotPdfChunkModel.countChunks();

  res.render("admin/manualPdfChunks", {
    title: "Manual PDF Chunks",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    returnPath: req.originalUrl || "/admin/pdf-chunks/manual",
    data: {
      chunkCount,
      sampleKeyword: "โครงสร้างสหกรณ์",
      sampleText:
        "โครงสร้างของสหกรณ์ ตั้งอยู่บนรากฐานของประชาธิปไตย สมาชิกทุกคนเป็นเจ้าของสหกรณ์ แต่ทุกคนไม่สามารถร่วมบริหารกิจการของสหกรณ์ได้ จึงต้องมีการเลือกตั้งคณะกรรมการดำเนินการเป็นผู้บริหารงานแทน ตามพระราชบัญญัติสหกรณ์ พ.ศ. 2542 กำหนดให้มีคณะกรรมการดำเนินการไม่เกิน 15 คน มีอำนาจหน้าที่เป็นผู้ดำเนินกิจการและเป็นผู้แทนสหกรณ์ในกิจการทั้งปวงเพื่อให้กิจการสหกรณ์ดำเนินการอย่างกว้างขวาง และให้บริการแก่สมาชิกอย่างทั่วถึง คณะกรรมการดำเนินการควรจัดจ้างผู้จัดการที่มีความรู้ความสามารถมาดำเนินธุรกิจแทน และผู้จัดการอาจจัดจ้างเจ้าหน้าที่โดยความเห็นชอบของคณะกรรมการดำเนินการ เพื่อช่วยเหลือกิจการสหกรณ์ด้านต่างๆ ตามความเหมาะสมโดยคำนึงถึงปริมาณธุรกิจและการประหยัดเป็นสำคัญ",
    },
  });
}

async function submitManualPdfChunks(req, res) {
  const returnTo = sanitizePdfChunkAdminReturnPath(req.body.returnTo, "/admin/pdf-chunks/manual");
  const keyword = String(req.body.keyword || "").trim();
  const rawChunkText = String(req.body.chunkText || "").trim();
  const splitMode = String(req.body.splitMode || "single").trim() === "auto" ? "auto" : "single";
  const documentId = Number(req.body.documentId || 0) || null;
  const qualityScore = Number.isFinite(Number(req.body.qualityScore))
    ? Math.max(0, Math.min(100, Number(req.body.qualityScore)))
    : 80;
  const isActive = String(req.body.isActive || "1").trim() === "0" ? 0 : 1;

  if (!keyword || !rawChunkText) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "กรุณากรอก keyword และข้อความ chunk ก่อนบันทึก")
    );
  }

  const chunks = splitManualChunkText(keyword, rawChunkText, splitMode);
  if (chunks.length === 0) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบข้อความที่พร้อมใช้สำหรับสร้าง chunk")
    );
  }

  await LawChatbotPdfChunkModel.insertChunks(
    chunks.map((chunk) => ({
      keyword: chunk.keyword,
      chunkText: chunk.chunkText,
      documentId,
      isActive,
      qualityScore,
    })),
    documentId,
  );

  const successMessage =
    chunks.length > 1
      ? `บันทึก ${chunks.length} chunks แบบ auto split เรียบร้อยแล้ว`
      : "บันทึก manual chunk เรียบร้อยแล้ว";

  return res.redirect(appendQueryParam(returnTo, "success", successMessage));
}

async function renderVinichai(req, res) {
  const data = await vinichaiAdminService.getVinichaiAdminData({
    query: req.query.q || "",
    page: req.query.page || 1,
    pageSize: req.query.perPage || 12,
  });

  res.render("admin/vinichai", {
    title: "Vinichai Management",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
    returnPath: req.originalUrl || "/admin/vinichai",
    todayDate: new Date().toISOString().slice(0, 10),
  });
}

async function updateAiSetting(req, res) {
  const rawEnabled = String(req.body.enabled || "").trim().toLowerCase();
  if (!["true", "false"].includes(rawEnabled)) {
    return res.redirect(
      "/admin?error=" + encodeURIComponent("ไม่พบสถานะ AI ที่ต้องการบันทึก")
    );
  }

  const enabled = rawEnabled === "true";
  const updatedBy =
    (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
    "admin";

  await runtimeSettingsService.setAiEnabled(enabled, updatedBy);

  return res.redirect(
    "/admin?success=" +
      encodeURIComponent(
        enabled
          ? "เปิดการใช้งาน AI สำหรับสรุปคำตอบเรียบร้อยแล้ว"
          : "ปิด AI สำหรับสรุปคำตอบเรียบร้อยแล้ว ระบบจะค้นข้อมูลจากฐานข้อมูลต่อไปโดยไม่เรียก AI"
      )
  );
}

async function submitVinichai(req, res) {
  const returnTo = sanitizeVinichaiReturnPath(req.body.returnTo, "/admin/vinichai");
  const requiredFields = [
    ["vinGroup", "vin_group"],
    ["vinKey", "vin_key"],
    ["vinQuestion", "vin_question"],
    ["vinDetail", "vin_detail"],
    ["vinMaihed", "vin_maihed"],
  ];

  const hasAllRequired = requiredFields.every(([camel, snake]) => {
    return String(req.body[camel] || req.body[snake] || "").trim();
  });

  if (!hasAllRequired) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "กรุณากรอกข้อมูลให้ครบก่อนบันทึกวินิจฉัย")
    );
  }

  const result = await vinichaiAdminService.saveVinichaiEntry(req.body, {
    saveBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
    vinSavedate: req.body.vinSavedate || req.body.vin_savedate || "",
  });

  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถบันทึกข้อมูลวินิจฉัยรายการนี้ได้")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", `บันทึกวินิจฉัย "${result.entry?.vinQuestion || result.entry?.vin_key || req.body.vinQuestion || "รายการใหม่"}" เรียบร้อยแล้ว`)
  );
}

async function updateVinichai(req, res) {
  const returnTo = sanitizeVinichaiReturnPath(req.body.returnTo, "/admin/vinichai");
  const id = Number(req.body.id || req.body.vin_id || 0);
  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการวินิจฉัยที่ต้องการแก้ไข")
    );
  }

  const requiredFields = [
    ["vinGroup", "vin_group"],
    ["vinKey", "vin_key"],
    ["vinQuestion", "vin_question"],
    ["vinDetail", "vin_detail"],
    ["vinMaihed", "vin_maihed"],
  ];

  const hasAllRequired = requiredFields.every(([camel, snake]) => {
    return String(req.body[camel] || req.body[snake] || "").trim();
  });

  if (!hasAllRequired) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "กรุณากรอกข้อมูลให้ครบก่อนบันทึกการแก้ไขวินิจฉัย")
    );
  }

  const result = await vinichaiAdminService.updateVinichaiEntry(id, req.body, {
    saveBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
    vinSavedate: req.body.vinSavedate || req.body.vin_savedate || "",
  });

  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถบันทึกการแก้ไขรายการวินิจฉัยนี้ได้")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", `บันทึกการแก้ไขวินิจฉัย "${result.entry?.vinQuestion || req.body.vinQuestion || "รายการเดิม"}" เรียบร้อยแล้ว`)
  );
}

async function deleteVinichai(req, res) {
  const returnTo = sanitizeVinichaiReturnPath(req.body.returnTo, "/admin/vinichai");
  const id = Number(req.body.id || req.body.vin_id || 0);

  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการวินิจฉัยที่ต้องการลบ")
    );
  }

  const removed = await vinichaiAdminService.deleteVinichaiEntry(id);
  if (!removed) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการวินิจฉัยที่ต้องการลบ หรืออาจถูกลบไปแล้ว")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", "ลบรายการวินิจฉัยเรียบร้อยแล้ว")
  );
}

async function renderPaymentRequests(req, res) {
  const data = await lawChatbotService.getAdminPaymentRequestsData({
    page: req.query.page || 1,
    pageSize: req.query.perPage || 12,
  });

  res.render("admin/paymentRequests", {
    title: "Payment Requests",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
    returnPath: req.originalUrl || "/admin/payment-requests",
  });
}

async function renderUsers(req, res) {
  const data = await lawChatbotService.getAdminUsersData(req.query.q || "", {
    page: req.query.page || 1,
    pageSize: req.query.perPage || 12,
  });

  res.render("admin/users", {
    title: "Manage Users",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
    returnPath: req.originalUrl || "/admin/users",
  });
}

async function renderGuestUsage(req, res) {
  const data = await lawChatbotService.getAdminGuestUsageData({
    query: req.query.q || "",
    usageMonth: req.query.month || "",
    identityType: req.query.identityType || "",
    page: req.query.page || 1,
    pageSize: req.query.perPage || 20,
  });

  res.render("admin/guestUsage", {
    title: "Guest Usage Monitor",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
    returnPath: req.originalUrl || "/admin/guest-usage",
  });
}

async function exportGuestUsageCsv(req, res) {
  const data = await lawChatbotService.getAdminGuestUsageData({
    query: req.query.q || "",
    usageMonth: req.query.month || "",
    identityType: req.query.identityType || "",
    page: 1,
    pageSize: 5000,
  });

  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const rows = [
    ["id", "identity_type", "identity_type_label", "identity_hash", "usage_month", "question_count", "is_blocked", "last_used_at", "created_at", "updated_at"],
    ...data.records.map((record) => [
      record.id,
      record.identity_type,
      record.identityTypeLabel,
      record.identity_hash,
      record.usage_month,
      Number(record.question_count || 0),
      record.isBlocked ? "true" : "false",
      record.last_used_at || "",
      record.created_at || "",
      record.updated_at || "",
    ]),
  ];

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="guest-usage-${data.usageMonth || "all"}.csv"`);
  return res.send(`\uFEFF${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}`);
}

async function clearGuestUsage(req, res) {
  const returnTo = sanitizeGuestUsageReturnPath(req.body.returnTo, "/admin/guest-usage");
  const deletedCount = await lawChatbotService.clearAdminGuestUsage({
    id: req.body.id,
    query: req.body.q || "",
    usageMonth: req.body.month || "",
    identityType: req.body.identityType || "",
  });

  if (!deletedCount) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบ guest usage ที่ตรงเงื่อนไขให้ล้าง")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", `ล้าง guest usage เรียบร้อย ${deletedCount} รายการ`)
  );
}

async function renderPaymentRequestDetail(req, res) {
  const data = await lawChatbotService.getAdminPaymentRequestDetail(req.params.id);
  if (!data) {
    return res.redirect(
      "/admin/payment-requests?error=" +
        encodeURIComponent("ไม่พบคำขอชำระเงินที่ต้องการ")
    );
  }

  res.render("admin/paymentRequestDetail", {
    title: "Payment Request Detail",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
  });
}

async function updatePaymentRequestPlan(req, res) {
  const id = Number(req.body.id || 0);
  const planCode = String(req.body.planCode || req.body.planName || "").trim();
  const returnTo = sanitizePaymentRequestReturnPath(
    req.body.returnTo,
    id ? `/admin/payment-requests/${id}` : "/admin/payment-requests",
  );

  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบคำขอชำระเงินที่ต้องการแก้ไขแพ็กเกจ")
    );
  }

  const result = await lawChatbotService.updatePaymentRequestPlan(id, planCode);
  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถอัปเดตแพ็กเกจของคำขอชำระเงินนี้ได้")
    );
  }

  return res.redirect(
    appendQueryParam(
      returnTo,
      "success",
      `อัปเดตแพ็กเกจเป็น ${result.planLabel || "ที่เลือก"} แล้ว ยอดชำระถูกปรับอัตโนมัติเป็น ${Number(result.amount || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`,
    )
  );
}

async function updateUserPlan(req, res) {
  const userId = Number(req.body.userId || req.body.id || 0);
  const planCode = String(req.body.planCode || "").trim();
  const durationDays = Number(req.body.durationDays || 0);
  const fallbackPath = userId ? "/admin/users" : "/admin/users";
  const returnTo = sanitizeAdminUsersReturnPath(req.body.returnTo, fallbackPath);

  if (!userId) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบผู้ใช้ที่ต้องการอัปเดตแพ็กเกจ")
    );
  }

  const result = await lawChatbotService.adminUpdateUserPlan(userId, planCode, {
    durationDays,
    updatedBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
  });

  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถอัปเดตแพ็กเกจของผู้ใช้งานรายนี้ได้")
    );
  }

  const displayName = result.user?.name || result.user?.email || `#${userId}`;
  const successMessage =
    result.planCode === "free"
      ? `ปรับแพ็กเกจของ ${displayName} เป็นแพ็กเกจฟรีแล้ว และล้างวันหมดอายุแพ็กเกจเรียบร้อย`
      : `ปรับแพ็กเกจของ ${displayName} เป็น ${result.planLabel} ${result.durationDays} วัน เรียบร้อยแล้ว${
          result.user?.planExpiresAt
            ? ` (หมดอายุ ${new Date(result.user.planExpiresAt).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })})`
            : ""
        }`;

  return res.redirect(
    appendQueryParam(returnTo, "success", successMessage)
  );
}

async function resetUserQuestionCount(req, res) {
  const userId = Number(req.body.userId || req.body.id || 0);
  const usageMonth = String(req.body.usageMonth || req.body.month || "").trim();
  const returnTo = sanitizeAdminUsersReturnPath(req.body.returnTo, "/admin/users");

  if (!userId) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบผู้ใช้ที่ต้องการรีเซ็ตจำนวนคำถาม")
    );
  }

  const result = await lawChatbotService.resetUserQuestionCount(userId, usageMonth);
  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบข้อมูลจำนวนคำถามของผู้ใช้งานรายนี้ในเดือนปัจจุบัน")
    );
  }

  const displayName = result.user?.name || result.user?.email || `#${userId}`;
  return res.redirect(
    appendQueryParam(
      returnTo,
      "success",
      `รีเซ็ตจำนวนคำถามของ ${displayName} ประจำเดือน ${result.usageMonth || usageMonth || "ปัจจุบัน"} จาก ${Number(result.previousQuestionCount || 0)} เป็น 0 เรียบร้อยแล้ว`,
    )
  );
}

async function submitKnowledge(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/knowledge");
  const title = String(req.body.title || "").trim();
  const content = String(req.body.content || "").trim();

  if (!title || !content) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "กรุณากรอกหัวข้อและรายละเอียดความรู้ก่อนบันทึก")
    );
  }

  await lawChatbotService.saveKnowledgeEntry(req.body);
  return res.redirect(
    appendQueryParam(returnTo, "success", "บันทึกความรู้ใหม่เรียบร้อยแล้ว และพร้อมใช้ในการตอบคำถาม")
  );
}

async function submitSuggestedQuestion(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/suggested-questions");
  const questionText = String(req.body.questionText || req.body.question || "").trim();
  const answerText = String(req.body.answerText || req.body.answer || "").trim();

  if (!questionText || !answerText) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "กรุณากรอกคำถามแนะนำและคำตอบให้ครบก่อนบันทึก")
    );
  }

  const result = await lawChatbotService.saveSuggestedQuestionEntry(req.body);
  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถบันทึกคำถามแนะนำรายการนี้ได้")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", `บันทึกคำถามแนะนำ "${result.entry?.questionText || questionText}" เรียบร้อยแล้ว`)
  );
}

async function updateKnowledge(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/knowledge");
  const id = Number(req.body.id || 0);
  const title = String(req.body.title || "").trim();
  const content = String(req.body.content || "").trim();

  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการฐานความรู้ที่ต้องการแก้ไข")
    );
  }

  if (!title || !content) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "กรุณากรอกหัวข้อและรายละเอียดความรู้ก่อนบันทึกการแก้ไข")
    );
  }

  const result = await lawChatbotService.updateKnowledgeEntry(id, req.body);
  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถบันทึกการแก้ไขข้อมูลฐานความรู้นี้ได้")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", `บันทึกการแก้ไขข้อมูลฐานความรู้ "${result.entry?.title || title}" เรียบร้อยแล้ว`)
  );
}

async function updateSuggestedQuestion(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/suggested-questions");
  const id = Number(req.body.id || 0);
  const questionText = String(req.body.questionText || req.body.question || "").trim();
  const answerText = String(req.body.answerText || req.body.answer || "").trim();

  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการคำถามแนะนำที่ต้องการแก้ไข")
    );
  }

  if (!questionText || !answerText) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "กรุณากรอกคำถามแนะนำและคำตอบให้ครบก่อนบันทึกการแก้ไข")
    );
  }

  const result = await lawChatbotService.updateSuggestedQuestionEntry(id, req.body);
  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถบันทึกการแก้ไขคำถามแนะนำรายการนี้ได้")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", `บันทึกการแก้ไขคำถามแนะนำ "${result.entry?.questionText || questionText}" เรียบร้อยแล้ว`)
  );
}

async function deleteKnowledge(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/knowledge");
  const id = Number(req.body.id || 0);

  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการฐานความรู้ที่ต้องการลบ")
    );
  }

  const removed = await lawChatbotService.deleteKnowledgeEntry(id);
  if (!removed) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบข้อมูลฐานความรู้ที่ต้องการลบ หรืออาจถูกลบไปแล้ว")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", "ลบข้อมูลฐานความรู้เรียบร้อยแล้ว")
  );
}

async function deleteSuggestedQuestion(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/suggested-questions");
  const id = Number(req.body.id || 0);

  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการคำถามแนะนำที่ต้องการลบ")
    );
  }

  const removed = await lawChatbotService.deleteSuggestedQuestionEntry(id);
  if (!removed) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบคำถามแนะนำที่ต้องการลบ หรืออาจถูกลบไปแล้ว")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", "ลบคำถามแนะนำเรียบร้อยแล้ว")
  );
}

async function approveKnowledgeSuggestion(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/knowledge-suggestions");
  const id = Number(req.body.id || 0);
  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการข้อเสนอที่ต้องการอนุมัติ")
    );
  }

  const result = await lawChatbotService.approveKnowledgeSuggestion(id, {
    reviewedBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
  });

  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบข้อเสนอที่ต้องการอนุมัติ หรือรายการนี้ถูกดำเนินการไปแล้ว")
    );
  }

  const successMessage = result.rewardSummary?.grantedBonusQuestions
    ? "อนุมัติข้อเสนอและบันทึกเป็นคำถามแนะนำเรียบร้อยแล้ว ผู้เสนอจะได้รับสิทธิ์ถามฟรีเพิ่ม 1 ครั้งต่อเดือน"
    : "อนุมัติข้อเสนอและบันทึกเป็นคำถามแนะนำเรียบร้อยแล้ว";

  return res.redirect(
    appendQueryParam(returnTo, "success", successMessage)
  );
}

async function updateKnowledgeSuggestion(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/knowledge-suggestions");
  const id = Number(req.body.id || 0);
  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการข้อเสนอที่ต้องการแก้ไข")
    );
  }

  const result = await lawChatbotService.updateKnowledgeSuggestion(id, {
    target: req.body.target,
    title: req.body.title,
    content: req.body.content,
    reviewNote: req.body.reviewNote,
  });

  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถบันทึกการแก้ไขข้อเสนอรายการนี้ได้")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", "บันทึกการแก้ไขข้อเสนอเรียบร้อยแล้ว")
  );
}

async function rejectKnowledgeSuggestion(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/knowledge-suggestions");
  const id = Number(req.body.id || 0);
  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการข้อเสนอที่ต้องการปฏิเสธ")
    );
  }

  const rejected = await lawChatbotService.rejectKnowledgeSuggestion(id, {
    reviewedBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
  });

  if (!rejected) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบข้อเสนอที่ต้องการปฏิเสธ หรือรายการนี้ถูกดำเนินการไปแล้ว")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", "ปฏิเสธข้อเสนอเรียบร้อยแล้ว")
  );
}

async function saveKnowledgeSuggestionAsKnowledge(req, res) {
  const returnTo = sanitizeKnowledgeAdminReturnPath(req.body.returnTo, "/admin/knowledge-suggestions");
  const id = Number(req.body.id || 0);
  if (!id) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่พบรายการข้อเสนอที่ต้องการบันทึกเป็นฐานความรู้")
    );
  }

  const result = await lawChatbotService.saveKnowledgeSuggestionAsKnowledgeEntry(id, {
    reviewedBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
    reviewNote: "บันทึกเป็นฐานความรู้แล้ว",
  });

  if (!result.ok) {
    return res.redirect(
      appendQueryParam(returnTo, "error", "ไม่สามารถบันทึกข้อเสนอนี้เป็นฐานความรู้ได้")
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", `บันทึกข้อเสนอ \"${result.entry?.title || result.suggestion?.title || "รายการนี้"}\" เป็นฐานความรู้เรียบร้อยแล้ว`)
  );
}

async function approvePaymentRequest(req, res) {
  const id = Number(req.body.id || 0);
  if (!id) {
    return res.redirect(
      "/admin/payment-requests?error=" +
        encodeURIComponent("ไม่พบคำขอชำระเงินที่ต้องการอนุมัติ")
    );
  }

  const result = await lawChatbotService.approvePaymentRequest(id, {
    reviewedBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
  });

  if (!result.ok) {
    return res.redirect(
      "/admin/payment-requests?error=" +
        encodeURIComponent("ไม่สามารถอนุมัติคำขอชำระเงินนี้ได้")
    );
  }

  return res.redirect(
    `/admin/payment-requests/${id}?success=` +
      encodeURIComponent(
        `อนุมัติคำขอชำระเงินและเปิดใช้งานแพ็กเกจ ${result.planLabel || "ที่ร้องขอ"} 30 วันเรียบร้อยแล้ว`
      )
  );
}

async function rejectPaymentRequest(req, res) {
  const id = Number(req.body.id || 0);
  if (!id) {
    return res.redirect(
      "/admin/payment-requests?error=" +
        encodeURIComponent("ไม่พบคำขอชำระเงินที่ต้องการปฏิเสธ")
    );
  }

  const result = await lawChatbotService.rejectPaymentRequest(id, {
    reviewedBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
  });

  if (!result.ok) {
    return res.redirect(
      "/admin/payment-requests?error=" +
        encodeURIComponent("ไม่สามารถปฏิเสธคำขอชำระเงินนี้ได้")
    );
  }

  return res.redirect(
    `/admin/payment-requests/${id}?success=` +
      encodeURIComponent(
        `ปฏิเสธคำขอชำระเงินแพ็กเกจ ${result.planLabel || "ที่ร้องขอ"} เรียบร้อยแล้ว สถานะแพ็กเกจปัจจุบันของผู้ใช้ยังคงเดิม`
      )
  );
}

function logout(req, res) {
  req.session.destroy(() => {
    res.redirect("/admin/login?success=" + encodeURIComponent("ออกจากระบบเรียบร้อยแล้ว"));
  });
}

module.exports = {
  renderLogin,
  submitLogin,
  redirectToGoogleLogin,
  handleGoogleCallback,
  renderDashboard,
  renderSuggestedQuestions,
  renderKnowledge,
  renderKnowledgeSuggestions,
  renderManualPdfChunks,
  renderVinichai,
  renderGuestUsage,
  exportGuestUsageCsv,
  clearGuestUsage,
  renderUsers,
  renderPaymentRequests,
  renderPaymentRequestDetail,
  updateUserPlan,
  resetUserQuestionCount,
  updatePaymentRequestPlan,
  submitKnowledge,
  submitManualPdfChunks,
  submitSuggestedQuestion,
  submitVinichai,
  updateKnowledge,
  updateSuggestedQuestion,
  updateVinichai,
  deleteKnowledge,
  deleteSuggestedQuestion,
  deleteVinichai,
  updateKnowledgeSuggestion,
  approveKnowledgeSuggestion,
  rejectKnowledgeSuggestion,
  saveKnowledgeSuggestionAsKnowledge,
  approvePaymentRequest,
  rejectPaymentRequest,
  updateAiSetting,
  logout,
};
