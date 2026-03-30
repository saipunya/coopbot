const lawChatbotService = require("../services/lawChatbotService");
const { loginAdmin } = require("../services/adminAuthService");

function renderLogin(req, res) {
  res.render("admin/login", {
    title: "Admin Login",
    errorMessage: req.query.error || "",
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

  req.session.adminUser = result.user;
  return res.redirect("/admin");
}

async function renderDashboard(req, res) {
  const uploadData = await lawChatbotService.getUploadPageData();
  const feedbackData = await lawChatbotService.getFeedbackPageData();
  const knowledgeData = await lawChatbotService.getKnowledgeAdminData();

  res.render("admin/dashboard", {
    title: "Admin Dashboard",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    uploadData,
    feedbackData,
    knowledgeData,
  });
}

async function submitKnowledge(req, res) {
  const title = String(req.body.title || "").trim();
  const content = String(req.body.content || "").trim();

  if (!title || !content) {
    return res.redirect(
      "/admin?error=" +
        encodeURIComponent("กรุณากรอกหัวข้อและรายละเอียดความรู้ก่อนบันทึก")
    );
  }

  await lawChatbotService.saveKnowledgeEntry(req.body);
  return res.redirect(
    "/admin?success=" +
      encodeURIComponent("บันทึกความรู้ใหม่เรียบร้อยแล้ว และพร้อมใช้ในการตอบคำถาม")
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
  renderDashboard,
  submitKnowledge,
  logout,
};
