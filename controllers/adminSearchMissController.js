const SearchMissLogModel = require("../models/searchMissLogModel");
const LawChatbotSuggestedQuestionModel = require("../models/lawChatbotSuggestedQuestionModel");

function sanitizeReturnPath(value, fallbackPath = "/admin/search-misses") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (!path.startsWith("/admin/search-misses")) {
    return fallbackPath;
  }

  return path;
}

function appendQueryParam(path, key, value) {
  const normalizedPath = String(path || "").trim() || "/admin/search-misses";
  const separator = normalizedPath.includes("?") ? "&" : "?";
  return `${normalizedPath}${separator}${encodeURIComponent(key)}=${encodeURIComponent(String(value || ""))}`;
}

async function renderSearchMisses(req, res) {
  const groupedMisses = await SearchMissLogModel.listGrouped();

  res.render("admin/searchMisses", {
    title: "Search Miss Logs",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    groupedMisses,
  });
}

async function renderNewFaq(req, res) {
  const query = String(req.query.query || "").trim();

  res.render("admin/searchMissNewFaq", {
    title: "เพิ่ม Search Miss เข้า Q&A",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    query,
    defaults: {
      domain: "legal",
      target: "all",
      displayOrder: 0,
      isActive: 1,
    },
  });
}

async function createFaq(req, res) {
  const returnTo = sanitizeReturnPath(req.body.returnTo, "/admin/search-misses");
  const questionText = String(req.body.question_text || req.body.questionText || "").trim();
  const answerText = String(req.body.answer_text || req.body.answerText || "").trim();

  if (!questionText || !answerText) {
    return res.redirect(
      appendQueryParam(
        `/admin/search-misses/new-faq?query=${encodeURIComponent(questionText)}`,
        "error",
        "กรุณากรอกคำถามและคำตอบให้ครบก่อนบันทึก",
      ),
    );
  }

  const entry = await LawChatbotSuggestedQuestionModel.create({
    domain: req.body.domain || "legal",
    target: req.body.target || "all",
    questionText,
    answerText,
    sourceReference: req.body.source_reference || req.body.sourceReference,
    displayOrder: req.body.display_order || req.body.displayOrder || 0,
    isActive: req.body.is_active ?? req.body.isActive ?? 1,
  });

  if (!entry) {
    return res.redirect(
      appendQueryParam(
        `/admin/search-misses/new-faq?query=${encodeURIComponent(questionText)}`,
        "error",
        "ไม่สามารถบันทึก Q&A จาก search miss ได้",
      ),
    );
  }

  return res.redirect(
    appendQueryParam(returnTo, "success", `เพิ่ม "${entry.questionText || questionText}" เข้า Q&A เรียบร้อยแล้ว`),
  );
}

async function deleteQuery(req, res) {
  const query = String(req.body.query || "").trim();
  const result = await SearchMissLogModel.removeQuery(query);

  return res.redirect(
    appendQueryParam(
      "/admin/search-misses",
      "success",
      result.removedCount > 0
        ? `ลบ "${query}" ออกจาก search miss log แล้ว ${result.removedCount} รายการ`
        : "ไม่พบ query นี้ใน search miss log",
    ),
  );
}

module.exports = {
  createFaq,
  deleteQuery,
  renderNewFaq,
  renderSearchMisses,
};
