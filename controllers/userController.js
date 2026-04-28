const lawChatbotService = require("../services/lawChatbotService");
const UserModel = require("../models/userModel");
const { normalizeResponseTone } = require("../services/chatAnswerService");

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

async function renderSearchHistory(req, res) {
  const data = await lawChatbotService.getUserSearchHistoryData(req.session.user);

  res.render("user/searchHistory", {
    title: "ประวัติการค้นหา",
    page: "user",
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
  });
}

async function updateSettings(req, res) {
  try {
    const signedInUser = req.session?.user || {};
    const userId = Number(signedInUser.userId || signedInUser.id || 0);
    const responseTone = normalizeResponseTone(req.body?.responseTone);

    if (!userId) {
      return res.redirect("/auth/google?returnTo=%2Fuser");
    }

    const updatedUser = await UserModel.updateResponseTone(userId, responseTone);
    if (!updatedUser) {
      return res.redirect(
        "/user?error=" + encodeURIComponent("ไม่สามารถบันทึกการตั้งค่าได้ กรุณาลองใหม่อีกครั้ง"),
      );
    }

    req.session.user = {
      ...signedInUser,
      responseTone,
    };

    return req.session.save((error) => {
      if (error) {
        return res.redirect(
          "/user?error=" + encodeURIComponent("บันทึกแล้ว แต่ไม่สามารถอัปเดต session ได้ กรุณาเข้าสู่ระบบใหม่"),
        );
      }

      return res.redirect("/user?success=" + encodeURIComponent("บันทึกรูปแบบคำตอบเรียบร้อยแล้ว"));
    });
  } catch (error) {
    console.error("[user/settings] Failed to update settings:", error);
    return res.redirect(
      "/user?error=" + encodeURIComponent("ไม่สามารถบันทึกการตั้งค่าได้ กรุณาลองใหม่อีกครั้ง"),
    );
  }
}

function logout(req, res) {
  req.session.destroy(() => {
    res.clearCookie("connect.sid");
    res.redirect("/law-chatbot");
  });
}

module.exports = {
  renderDashboard,
  renderSearchHistory,
  updateSettings,
  logout,
};
