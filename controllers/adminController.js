const lawChatbotService = require("../services/lawChatbotService");
const { loginAdmin } = require("../services/adminAuthService");
const {
  createGoogleAuthUrl,
  getGoogleConfig,
  loginWithGoogleCallback,
} = require("../services/adminGoogleAuthService");
const runtimeSettingsService = require("../services/runtimeSettingsService");

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

function renderLogin(req, res) {
  res.render("admin/login", {
    title: "Admin Login",
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
    lawChatbotService.getKnowledgeAdminData(),
    lawChatbotService.getAdminPaymentRequestsData(),
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

async function renderPaymentRequests(req, res) {
  const data = await lawChatbotService.getAdminPaymentRequestsData();

  res.render("admin/paymentRequests", {
    title: "Payment Requests",
    user: req.session.adminUser,
    errorMessage: req.query.error || "",
    successMessage: req.query.success || "",
    data,
  });
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
      `${returnTo}?error=` + encodeURIComponent("ไม่พบคำขอชำระเงินที่ต้องการแก้ไขแพ็กเกจ")
    );
  }

  const result = await lawChatbotService.updatePaymentRequestPlan(id, planCode);
  if (!result.ok) {
    return res.redirect(
      `${returnTo}?error=` + encodeURIComponent("ไม่สามารถอัปเดตแพ็กเกจของคำขอชำระเงินนี้ได้")
    );
  }

  return res.redirect(
    `${returnTo}?success=` +
      encodeURIComponent(
        `อัปเดตแพ็กเกจเป็น ${result.planLabel || "ที่เลือก"} แล้ว ยอดชำระถูกปรับอัตโนมัติเป็น ${Number(result.amount || 0).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท`
      )
  );
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

async function deleteKnowledge(req, res) {
  const id = Number(req.body.id || 0);

  if (!id) {
    return res.redirect(
      "/admin?error=" +
        encodeURIComponent("ไม่พบรายการฐานความรู้ที่ต้องการลบ")
    );
  }

  const removed = await lawChatbotService.deleteKnowledgeEntry(id);
  if (!removed) {
    return res.redirect(
      "/admin?error=" +
        encodeURIComponent("ไม่พบข้อมูลฐานความรู้ที่ต้องการลบ หรืออาจถูกลบไปแล้ว")
    );
  }

  return res.redirect(
    "/admin?success=" +
      encodeURIComponent("ลบข้อมูลฐานความรู้เรียบร้อยแล้ว")
  );
}

async function approveKnowledgeSuggestion(req, res) {
  const id = Number(req.body.id || 0);
  if (!id) {
    return res.redirect(
      "/admin?error=" +
        encodeURIComponent("ไม่พบรายการข้อเสนอที่ต้องการอนุมัติ")
    );
  }

  const result = await lawChatbotService.approveKnowledgeSuggestion(id, {
    reviewedBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
  });

  if (!result.ok) {
    return res.redirect(
      "/admin?error=" +
        encodeURIComponent("ไม่พบข้อเสนอที่ต้องการอนุมัติ หรือรายการนี้ถูกดำเนินการไปแล้ว")
    );
  }

  return res.redirect(
    "/admin?success=" +
      encodeURIComponent("อนุมัติข้อเสนอและนำเข้าฐานความรู้เรียบร้อยแล้ว")
  );
}

async function rejectKnowledgeSuggestion(req, res) {
  const id = Number(req.body.id || 0);
  if (!id) {
    return res.redirect(
      "/admin?error=" +
        encodeURIComponent("ไม่พบรายการข้อเสนอที่ต้องการปฏิเสธ")
    );
  }

  const rejected = await lawChatbotService.rejectKnowledgeSuggestion(id, {
    reviewedBy:
      (req.session.adminUser && (req.session.adminUser.email || req.session.adminUser.username || req.session.adminUser.name)) ||
      "admin",
  });

  if (!rejected) {
    return res.redirect(
      "/admin?error=" +
        encodeURIComponent("ไม่พบข้อเสนอที่ต้องการปฏิเสธ หรือรายการนี้ถูกดำเนินการไปแล้ว")
    );
  }

  return res.redirect(
    "/admin?success=" +
      encodeURIComponent("ปฏิเสธข้อเสนอเรียบร้อยแล้ว")
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
        `ปฏิเสธคำขอชำระเงินแพ็กเกจ ${result.planLabel || "ที่ร้องขอ"} เรียบร้อยแล้ว สถานะแผนปัจจุบันของผู้ใช้ยังคงเดิม`
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
  renderPaymentRequests,
  renderPaymentRequestDetail,
  updatePaymentRequestPlan,
  submitKnowledge,
  deleteKnowledge,
  approveKnowledgeSuggestion,
  rejectKnowledgeSuggestion,
  approvePaymentRequest,
  rejectPaymentRequest,
  updateAiSetting,
  logout,
};
