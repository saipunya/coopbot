const lawChatbotService = require("../services/lawChatbotService");

async function renderDashboard(req, res) {
  const data = await lawChatbotService.getUserDashboardData(req.session.user);

  res.render("user/dashboard", {
    title: "บัญชีผู้ใช้",
    page: "user",
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
  });
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/law-chatbot");
  });
}

module.exports = {
  renderDashboard,
  logout,
};
