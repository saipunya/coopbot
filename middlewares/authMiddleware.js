const LAW_CHATBOT_GUEST_QUESTION_LIMIT = 2;
const LAW_CHATBOT_GUEST_COUNT_KEY = "lawChatbotGuestQuestionCount";
const LAW_CHATBOT_FREE_MONTHLY_QUESTION_LIMIT = 20;
const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");

function attachCurrentUser(req, res, next) {
  req.user = req.session?.adminUser || null;
  req.signedInUser = req.session?.user || req.session?.adminUser || null;
  res.locals.currentUser = req.user;
  res.locals.signedInUser = req.signedInUser;
  next();
}

function enforceLawChatbotGuestLimit(req, res, next) {
  if (req.session?.adminUser) {
    return next();
  }

  const message = String(req.body?.message || "").trim();
  if (!message) {
    return next();
  }

  const guestQuestionCount = Number(req.session?.[LAW_CHATBOT_GUEST_COUNT_KEY] || 0);
  if (guestQuestionCount >= LAW_CHATBOT_GUEST_QUESTION_LIMIT) {
    return res.json({
      hasContext: true,
      answer:
        "คุณใช้สิทธิ์ถามคำถามในโหมด Guest ครบ 2 ครั้งแล้ว กรุณาเข้าสู่ระบบด้วย Google ที่ /auth/google เพื่อสนทนาต่อ",
      highlightTerms: [],
      usedFollowUpContext: false,
      usedInternetFallback: false,
      guestLimitReached: true,
      guestQuestionCount,
      guestQuestionLimit: LAW_CHATBOT_GUEST_QUESTION_LIMIT,
      signInPath: "/auth/google",
    });
  }

  req.session[LAW_CHATBOT_GUEST_COUNT_KEY] = guestQuestionCount + 1;
  return next();
}

async function enforceLawChatbotMonthlyUsageLimit(req, res, next) {
  if (req.session?.adminUser) {
    return next();
  }

  const message = String(req.body?.message || "").trim();
  if (!message) {
    return next();
  }

  const sessionUser = req.session?.user || null;
  const userId = Number(sessionUser?.userId || sessionUser?.id || 0);
  const plan = String(sessionUser?.plan || "free").trim().toLowerCase();

  if (!userId || plan !== "free") {
    return next();
  }

  try {
    const usageMonth = UserMonthlyUsageModel.getYearMonth();
    const usage = await UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth);
    const questionCount = Number(usage?.question_count || 0);

    if (questionCount >= LAW_CHATBOT_FREE_MONTHLY_QUESTION_LIMIT) {
      return res.json({
        hasContext: true,
        answer:
          "คุณใช้สิทธิ์ถามคำถามครบ 20 ครั้งของเดือนนี้แล้ว กรุณาอัปเกรดแพลนหรือรอรอบเดือนถัดไปเพื่อใช้งานต่อ",
        highlightTerms: [],
        usedFollowUpContext: false,
        usedInternetFallback: false,
        monthlyUsageLimitReached: true,
        questionCount,
        questionLimit: LAW_CHATBOT_FREE_MONTHLY_QUESTION_LIMIT,
        usageMonth,
      });
    }

    await UserMonthlyUsageModel.incrementQuestionCount(userId, usageMonth);
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireAdminAuth(req, res, next) {
  if (req.session?.adminUser) {
    req.user = req.session.adminUser;
    res.locals.currentUser = req.user;
    return next();
  }

  return res.redirect(
    "/admin/login?error=" + encodeURIComponent("กรุณาเข้าสู่ระบบผู้ดูแลก่อนใช้งาน")
  );
}

function requireSignedInUser(req, res, next) {
  const signedInUser = req.session?.user || req.session?.adminUser || null;
  if (signedInUser) {
    req.signedInUser = signedInUser;
    res.locals.signedInUser = signedInUser;
    return next();
  }

  return res.redirect(
    "/admin/login?error=" + encodeURIComponent("กรุณาเข้าสู่ระบบด้วย Google ก่อนส่งคำขอชำระเงิน")
  );
}

function redirectIfAuthenticated(req, res, next) {
  if (req.session?.adminUser) {
    return res.redirect("/admin");
  }

  next();
}

module.exports = {
  attachCurrentUser,
  enforceLawChatbotGuestLimit,
  enforceLawChatbotMonthlyUsageLimit,
  requireAdminAuth,
  requireSignedInUser,
  redirectIfAuthenticated,
};
