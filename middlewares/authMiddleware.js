const LAW_CHATBOT_GUEST_QUESTION_LIMIT = 2;
const LAW_CHATBOT_GUEST_COUNT_KEY = "lawChatbotGuestQuestionCount";
const LAW_CHATBOT_FREE_MONTHLY_QUESTION_LIMIT = 20;
const UserModel = require("../models/userModel");
const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");

function sanitizeReturnPath(value, fallbackPath = "/user") {
  const path = String(value || "").trim();
  if (!path || !path.startsWith("/") || path.startsWith("//")) {
    return fallbackPath;
  }

  if (path.startsWith("/auth/google")) {
    return fallbackPath;
  }

  return path;
}

function mapPersistedUserToSessionUser(sessionUser = {}, persistedUser = {}) {
  return {
    ...sessionUser,
    id: persistedUser.id || sessionUser.id || null,
    userId: persistedUser.id || sessionUser.userId || sessionUser.id || null,
    username: persistedUser.email || sessionUser.username || sessionUser.email || "",
    email: persistedUser.email || sessionUser.email || sessionUser.username || "",
    name: persistedUser.name || sessionUser.name || persistedUser.email || "",
    picture: persistedUser.avatar_url || sessionUser.picture || sessionUser.avatarUrl || "",
    avatarUrl: persistedUser.avatar_url || sessionUser.avatarUrl || sessionUser.picture || "",
    googleId: persistedUser.google_id || sessionUser.googleId || "",
    plan: persistedUser.plan || sessionUser.plan || "free",
    status: persistedUser.status || sessionUser.status || "active",
    premiumExpiresAt: persistedUser.premium_expires_at || sessionUser.premiumExpiresAt || null,
    authProvider: "google",
    group: sessionUser.group || "google-user",
    position: sessionUser.position || "Google User",
  };
}

async function attachCurrentUser(req, res, next) {
  if (req._currentUserAttached) {
    return next();
  }

  req._currentUserAttached = true;

  let adminUser = req.session?.adminUser || null;
  let googleUser = req.session?.user || null;

  if (adminUser && (adminUser.authProvider === "google" || adminUser.googleId)) {
    if (!googleUser) {
      googleUser = {
        ...adminUser,
        authProvider: "google",
        group: "google-user",
        position: "Google User",
      };
      req.session.user = googleUser;
    }

    delete req.session.adminUser;
    adminUser = null;
  }

  if (googleUser) {
    const userId = Number(googleUser.userId || googleUser.id || 0);
    if (userId) {
      try {
        const persistedUser = await UserModel.findById(userId);
        if (persistedUser) {
          googleUser = mapPersistedUserToSessionUser(googleUser, persistedUser);
          req.session.user = googleUser;
        }
      } catch (error) {
        console.error("Failed to hydrate signed-in Google user:", error.message || error);
      }
    }
  }

  req.user = adminUser;
  req.signedInUser = googleUser || adminUser || null;
  res.locals.currentUser = req.user;
  res.locals.signedInUser = req.signedInUser;
  res.locals.isGoogleUser = Boolean(googleUser);
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
        "คุณใช้สิทธิ์ถามคำถามในโหมด Guest ครบ 2 ครั้งแล้ว กรุณาเข้าสู่ระบบด้วย Google เพื่อสนทนาต่อ",
      highlightTerms: [],
      usedFollowUpContext: false,
      usedInternetFallback: false,
      guestLimitReached: true,
      guestQuestionCount,
      guestQuestionLimit: LAW_CHATBOT_GUEST_QUESTION_LIMIT,
      signInPath: "/auth/google?returnTo=%2Flaw-chatbot",
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

  const requestedPath = req.method === "GET" ? req.originalUrl : "/user";
  const returnTo = sanitizeReturnPath(requestedPath, "/user");
  return res.redirect(
    `/auth/google?returnTo=${encodeURIComponent(returnTo)}`
  );
}

function requireGoogleUser(req, res, next) {
  const googleUser = req.session?.user || null;
  if (googleUser) {
    req.signedInUser = googleUser;
    res.locals.signedInUser = googleUser;
    res.locals.isGoogleUser = true;
    return next();
  }

  const requestedPath = req.method === "GET" ? req.originalUrl : "/user";
  const returnTo = sanitizeReturnPath(requestedPath, "/user");
  return res.redirect(`/auth/google?returnTo=${encodeURIComponent(returnTo)}`);
}

function redirectIfAuthenticated(req, res, next) {
  if (req.session?.adminUser) {
    return res.redirect("/admin");
  }

  if (req.session?.user) {
    const targetPath = sanitizeReturnPath(req.query?.returnTo, "/user");
    return res.redirect(targetPath);
  }

  next();
}

module.exports = {
  attachCurrentUser,
  enforceLawChatbotGuestLimit,
  enforceLawChatbotMonthlyUsageLimit,
  requireAdminAuth,
  requireGoogleUser,
  requireSignedInUser,
  redirectIfAuthenticated,
};
