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

  res.render("admin/dashboard", {
    title: "Admin Dashboard",
    user: req.session.adminUser,
    uploadData,
    feedbackData,
  });
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
  logout,
};
