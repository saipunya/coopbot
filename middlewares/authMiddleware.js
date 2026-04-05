const crypto = require("crypto");

const LAW_CHATBOT_GUEST_QUESTION_LIMIT = 2;
const LAW_CHATBOT_GUEST_COUNT_KEY = "lawChatbotGuestQuestionCount";
const LAW_CHATBOT_GUEST_ID_COOKIE = "lawbot_guest_id";
const LAW_CHATBOT_GUEST_COOKIE_TTL_MS = 1000 * 60 * 60 * 24 * 180;
const LAW_CHATBOT_NOTICE_ACCEPTED_KEY = "lawChatbotNoticeAcceptedVersion";
const LAW_CHATBOT_NOTICE_VERSION = "2026-04-05";
const UserModel = require("../models/userModel");
const GuestMonthlyUsageModel = require("../models/guestMonthlyUsageModel");
const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");
const {
  getPlanLabel,
  getPlanConfig,
  isPaidPlan,
  normalizePlanCode,
} = require("../services/planService");
const { getContributionRewardSummary } = require("../services/contributionRewardService");

function getYearMonth(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function parseCookieHeader(cookieHeader = "") {
  return String(cookieHeader || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((accumulator, part) => {
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0) {
        return accumulator;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (!key) {
        return accumulator;
      }

      accumulator[key] = decodeURIComponent(value || "");
      return accumulator;
    }, {});
}

function hashIdentity(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function getGuestCookieId(req) {
  const cookies = parseCookieHeader(req?.headers?.cookie || "");
  const guestCookieId = String(cookies[LAW_CHATBOT_GUEST_ID_COOKIE] || "").trim();
  return /^[a-f0-9-]{16,}$/i.test(guestCookieId) ? guestCookieId : "";
}

function getClientIp(req) {
  const forwardedFor = String(req?.headers?.["x-forwarded-for"] || "").split(",")[0].trim();
  const reqIp = String(req?.ip || req?.socket?.remoteAddress || "").trim();
  return forwardedFor || reqIp || "unknown";
}

function getGuestNetworkFingerprint(req) {
  const clientIp = getClientIp(req);
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").trim().toLowerCase();
  const scheme = forwardedProto || (req?.secure ? "https" : "http");
  return hashIdentity(`${clientIp}|${scheme}|lawbot-guest`);
}

function getGuestDeviceHint(req) {
  const rawHint = String(req?.body?.guestDeviceHint || req?.headers?.["x-lawbot-guest-device"] || "").trim();
  if (!rawHint) {
    return "";
  }

  return rawHint.slice(0, 300);
}

function ensureGuestCookieId(req, res) {
  const existingGuestId = getGuestCookieId(req);
  if (existingGuestId) {
    return existingGuestId;
  }

  const guestId = crypto.randomUUID();
  res.cookie(LAW_CHATBOT_GUEST_ID_COOKIE, guestId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: LAW_CHATBOT_GUEST_COOKIE_TTL_MS,
    path: "/",
  });
  return guestId;
}

function buildGuestUsageIdentities(req, res) {
  const guestCookieId = ensureGuestCookieId(req, res);
  const networkFingerprint = getGuestNetworkFingerprint(req);
  const guestDeviceHint = getGuestDeviceHint(req);
  return [
    guestCookieId
      ? { identityType: "cookie", identityHash: hashIdentity(guestCookieId) }
      : null,
    networkFingerprint
      ? { identityType: "network", identityHash: networkFingerprint }
      : null,
    guestDeviceHint
      ? { identityType: "device_hint", identityHash: hashIdentity(guestDeviceHint) }
      : null,
  ].filter(Boolean);
}

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

function hasAcceptedLawChatbotNotice(req) {
  return String(req?.session?.[LAW_CHATBOT_NOTICE_ACCEPTED_KEY] || "").trim() === LAW_CHATBOT_NOTICE_VERSION;
}

function markLawChatbotNoticeAccepted(req) {
  if (!req.session) {
    return;
  }

  req.session[LAW_CHATBOT_NOTICE_ACCEPTED_KEY] = LAW_CHATBOT_NOTICE_VERSION;
}

function wantsJsonResponse(req) {
  const acceptHeader = String(req?.headers?.accept || "").toLowerCase();
  return Boolean(
    req?.xhr ||
      req?.is?.("application/json") ||
      acceptHeader.includes("application/json")
  );
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
    planStartedAt: persistedUser.plan_started_at || sessionUser.planStartedAt || null,
    planExpiresAt: persistedUser.plan_expires_at || sessionUser.planExpiresAt || null,
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

    if (req.session && Object.prototype.hasOwnProperty.call(req.session, LAW_CHATBOT_GUEST_COUNT_KEY)) {
      delete req.session[LAW_CHATBOT_GUEST_COUNT_KEY];
    }
  }

  req.user = adminUser;
  req.signedInUser = googleUser || adminUser || null;
  res.locals.currentUser = req.user;
  res.locals.signedInUser = req.signedInUser;
  res.locals.isGoogleUser = Boolean(googleUser);
  next();
}

async function enforceLawChatbotGuestLimit(req, res, next) {
  if (req.session?.adminUser || req.session?.user) {
    if (req.session && Object.prototype.hasOwnProperty.call(req.session, LAW_CHATBOT_GUEST_COUNT_KEY)) {
      delete req.session[LAW_CHATBOT_GUEST_COUNT_KEY];
    }
    return next();
  }

  const message = String(req.body?.message || "").trim();
  if (!message) {
    return next();
  }

  try {
    const usageMonth = getYearMonth();
    const identities = buildGuestUsageIdentities(req, res);
    const usageRecords = await Promise.all(
      identities.map((identity) =>
        GuestMonthlyUsageModel.findByIdentity(identity.identityType, identity.identityHash, usageMonth),
      ),
    );
    const guestQuestionCount = usageRecords.reduce(
      (maxCount, usage) => Math.max(maxCount, Number(usage?.question_count || 0)),
      Number(req.session?.[LAW_CHATBOT_GUEST_COUNT_KEY] || 0),
    );

    if (guestQuestionCount >= LAW_CHATBOT_GUEST_QUESTION_LIMIT) {
      req.session[LAW_CHATBOT_GUEST_COUNT_KEY] = guestQuestionCount;
      return res.json({
        hasContext: true,
        answer:
          "คุณใช้สิทธิ์ถามคำถามในโหมด Guest ครบ 2 ครั้งแล้ว ระบบจะจำสิทธิ์ตามอุปกรณ์และเครือข่าย กรุณาเข้าสู่ระบบด้วย Google เพื่อสนทนาต่อ",
        highlightTerms: [],
        usedFollowUpContext: false,
        usedInternetFallback: false,
        guestLimitReached: true,
        guestQuestionCount,
        guestQuestionLimit: LAW_CHATBOT_GUEST_QUESTION_LIMIT,
        signInPath: "/auth/google?returnTo=%2Flaw-chatbot",
      });
    }

    const nextGuestQuestionCount = guestQuestionCount + 1;
    await GuestMonthlyUsageModel.syncQuestionCount(identities, usageMonth, nextGuestQuestionCount);
    req.session[LAW_CHATBOT_GUEST_COUNT_KEY] = nextGuestQuestionCount;
    return next();
  } catch (error) {
    return next(error);
  }
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
  const planCode = normalizePlanCode(sessionUser?.plan || "free");
  const aiPreviewRequested =
    req.body?.aiPreview === true || String(req.body?.aiPreview || "").trim().toLowerCase() === "true";
  const planConfig = getPlanConfig(planCode);

  if (aiPreviewRequested && userId && planCode === "free") {
    return next();
  }

  if (!userId) {
    return next();
  }

  try {
    const rewardSummary = await getContributionRewardSummary(sessionUser);
    const baseQuestionLimit = Number(planConfig.monthlyLimit);
    const bonusQuestionLimit = Number(rewardSummary.bonusQuestionLimit || 0);
    const questionLimit = Number.isFinite(baseQuestionLimit) ? baseQuestionLimit + bonusQuestionLimit : baseQuestionLimit;

    if (!Number.isFinite(questionLimit) || questionLimit <= 0) {
      return next();
    }

    const usageMonth = UserMonthlyUsageModel.getYearMonth();
    const usage = await UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth);
    const questionCount = Number(usage?.question_count || 0);

    if (questionCount >= questionLimit) {
      const limitLabel = bonusQuestionLimit > 0 ? `${questionLimit} ครั้ง (${baseQuestionLimit} พื้นฐาน + ${bonusQuestionLimit} โบนัส)` : `${questionLimit} ครั้ง`;
      const limitMessage =
        planCode === "premium"
          ? `คุณใช้สิทธิ์ถามคำถามครบ ${limitLabel} ของแพ็กเกจ ${getPlanLabel(planCode)} สำหรับเดือนนี้แล้ว กรุณารอรอบเดือนถัดไปเพื่อใช้งานต่อ`
          : isPaidPlan(planCode)
            ? `คุณใช้สิทธิ์ถามคำถามครบ ${limitLabel} ของแพ็กเกจ ${getPlanLabel(planCode)} สำหรับเดือนนี้แล้ว กรุณาอัปเกรดแพลนหรือรอรอบเดือนถัดไปเพื่อใช้งานต่อ`
            : `คุณใช้สิทธิ์ถามคำถามครบ ${limitLabel} ของแพ็กเกจ ${getPlanLabel(planCode)} สำหรับเดือนนี้แล้ว กรุณาอัปเกรดแพลนหรือรอรอบเดือนถัดไปเพื่อใช้งานต่อ`;
      return res.json({
        hasContext: true,
        answer: limitMessage,
        highlightTerms: [],
        usedFollowUpContext: false,
        usedInternetFallback: false,
        monthlyUsageLimitReached: true,
        questionCount,
        baseQuestionLimit,
        bonusQuestionLimit,
        questionLimit,
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
  if (wantsJsonResponse(req)) {
    return res.status(401).json({
      success: false,
      signInRequired: true,
      signInPath: `/auth/google?returnTo=${encodeURIComponent(returnTo)}`,
      message: "กรุณาเข้าสู่ระบบด้วย Google ก่อนใช้งาน",
    });
  }

  return res.redirect(
    `/auth/google?returnTo=${encodeURIComponent(returnTo)}`
  );
}

function requireLawChatbotNoticeAccepted(req, res, next) {
  if (req.session?.adminUser || hasAcceptedLawChatbotNotice(req)) {
    return next();
  }

  const requestedPath = req.method === "GET" ? req.originalUrl : "/law-chatbot";
  const returnTo = sanitizeReturnPath(requestedPath, "/law-chatbot");
  const redirectPath = `/law-chatbot?returnTo=${encodeURIComponent(returnTo)}`;

  if (wantsJsonResponse(req)) {
    return res.status(403).json({
      success: false,
      noticeRequired: true,
      redirectPath,
      message: "กรุณาอ่านคำประกาศชี้แจงและยอมรับก่อนใช้งาน",
    });
  }

  return res.redirect(redirectPath);
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
  hasAcceptedLawChatbotNotice,
  markLawChatbotNoticeAccepted,
  requireAdminAuth,
  requireGoogleUser,
  requireLawChatbotNoticeAccepted,
  requireSignedInUser,
  redirectIfAuthenticated,
};
