const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const LawChatbotSuggestedQuestionModel = require("../models/lawChatbotSuggestedQuestionModel");
const { getDbPool } = require("../config/db");
const PaymentRequestModel = require("../models/paymentRequestModel");
const UserModel = require("../models/userModel");
const GuestMonthlyUsageModel = require("../models/guestMonthlyUsageModel");
const UserMonthlyUsageModel = require("../models/userMonthlyUsageModel");
const UserSearchHistoryModel = require("../models/userSearchHistoryModel");
const { buildAiPreviewMeta } = require("./answerStateService");
const { buildPaginationMeta, normalizePageNumber, normalizePageSize } = require("./paginationUtils");
const {
  canUseSearchHistory,
  getPlanDurationDays,
  getPlanLabel,
  getPlanPriceBaht,
  getSearchHistoryRetentionLabel,
  isPaidPlan,
  listPlanComparisons,
  listPurchasablePlans,
  normalizePlanCode,
  resolveUserPlanContext,
} = require("./planService");
const { sendPaymentRequestNotification } = require("./telegramService");

async function findUserByIdForUpdate(connection, userId) {
  const [rows] = await connection.query(
    `SELECT id, google_id, email, name, avatar_url, plan, plan_started_at, plan_expires_at,
            premium_expires_at, status, created_at, updated_at
     FROM users
     WHERE id = ?
     LIMIT 1
     FOR UPDATE`,
    [Number(userId || 0)]
  );

  return rows[0] || null;
}

async function findPendingPaymentRequestByIdForUpdate(connection, id) {
  const [rows] = await connection.query(
    `SELECT id, user_id, plan_name, amount, slip_image, note, status,
            reviewed_at, reviewed_by, created_at, updated_at
     FROM payment_requests
     WHERE id = ? AND status = 'pending'
     LIMIT 1
     FOR UPDATE`,
    [Number(id || 0)]
  );

  return rows[0] || null;
}

function buildActivatedPlanState(currentUser = {}, planCode, durationDays) {
  const normalizedPlanCode = normalizePlanCode(planCode);
  const normalizedDays = Math.max(1, Number(durationDays || getPlanDurationDays()));
  const now = new Date();
  const currentPlanCode = normalizePlanCode(currentUser.plan || "free");
  const currentExpiry = currentUser.plan_expires_at || currentUser.premium_expires_at || null;
  const currentExpiryDate = currentExpiry ? new Date(currentExpiry) : null;
  const isSameActivePlan =
    normalizedPlanCode === currentPlanCode &&
    currentExpiryDate instanceof Date &&
    !Number.isNaN(currentExpiryDate.getTime()) &&
    currentExpiryDate > now;

  const planStartedAt =
    normalizedPlanCode === "free"
      ? now
      : isSameActivePlan && currentUser.plan_started_at
        ? new Date(currentUser.plan_started_at)
        : now;
  const planExpiresAt =
    normalizedPlanCode === "free"
      ? null
      : isSameActivePlan
        ? new Date(currentExpiryDate.getTime() + normalizedDays * 24 * 60 * 60 * 1000)
        : new Date(now.getTime() + normalizedDays * 24 * 60 * 60 * 1000);

  return {
    planCode: normalizedPlanCode,
    planStartedAt,
    planExpiresAt,
    premiumExpiresAt: normalizedPlanCode === "premium" ? planExpiresAt : null,
  };
}

async function activatePlanWithConnection(connection, userId, planCode, options = {}) {
  const currentUser = await findUserByIdForUpdate(connection, userId);
  if (!currentUser) {
    return false;
  }

  const nextPlanState = buildActivatedPlanState(currentUser, planCode, options.durationDays);
  const [result] = await connection.query(
    `UPDATE users
     SET plan = ?,
         plan_started_at = ?,
         plan_expires_at = ?,
         premium_expires_at = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      nextPlanState.planCode,
      nextPlanState.planStartedAt,
      nextPlanState.planExpiresAt,
      nextPlanState.premiumExpiresAt,
      Number(userId || 0),
    ]
  );

  return result.affectedRows > 0;
}

function enrichPaymentRequestRecord(record = {}) {
  const planCode = normalizePlanCode(record.plan_name || record.planName || "free");
  const currentPlanCode = normalizePlanCode(record.user_plan || "free");

  return {
    ...record,
    planCode,
    planLabel: getPlanLabel(planCode),
    userPlanCode: currentPlanCode,
    userPlanLabel: getPlanLabel(currentPlanCode),
    planPriceBaht: Number(record.amount || getPlanPriceBaht(planCode) || 0),
    userPlanExpiresAt: record.plan_expires_at || record.premium_expires_at || null,
  };
}

function listAdminManageablePlans() {
  const purchasable = listPurchasablePlans();
  return [
    {
      value: "free",
      code: "free",
      label: getPlanLabel("free"),
      priceBaht: 0,
      monthlyLimit: resolveUserPlanContext({ plan: "free" }).monthlyLimit,
      description: "ค้นฐานข้อมูลอย่างเดียว ไม่มี AI และไม่มี internet search",
    },
    ...purchasable,
  ];
}

function enrichAdminUserRecord(record = {}) {
  const planCode = normalizePlanCode(record.plan || "free");
  const planLabel = getPlanLabel(planCode);
  const expiresAt = record.plan_expires_at || record.premium_expires_at || null;
  const expiresDate = expiresAt ? new Date(expiresAt) : null;
  const now = new Date();
  const remainingDays =
    expiresDate instanceof Date && !Number.isNaN(expiresDate.getTime())
      ? Math.ceil((expiresDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      : null;

  return {
    ...record,
    planCode,
    planLabel,
    planPriceBaht: getPlanPriceBaht(planCode),
    searchHistoryRetentionLabel: getSearchHistoryRetentionLabel(planCode),
    monthlyLimit: resolveUserPlanContext({ plan: planCode }).monthlyLimit,
    planExpiresAt: expiresAt,
    remainingDays,
    isExpired:
      remainingDays !== null &&
      Number.isFinite(remainingDays) &&
      remainingDays < 0,
  };
}

function buildSignedInProfile(signedInUser = {}, persistedUser = null) {
  if (!persistedUser) {
    return signedInUser;
  }

  return {
    ...signedInUser,
    id: persistedUser.id,
    userId: persistedUser.id,
    username: persistedUser.email,
    email: persistedUser.email,
    name: persistedUser.name || signedInUser.name || persistedUser.email,
    picture: persistedUser.avatar_url || signedInUser.picture || signedInUser.avatarUrl || "",
    avatarUrl: persistedUser.avatar_url || signedInUser.avatarUrl || signedInUser.picture || "",
    googleId: persistedUser.google_id || signedInUser.googleId || "",
    plan: persistedUser.plan || signedInUser.plan || "free",
    planStartedAt: persistedUser.plan_started_at || signedInUser.planStartedAt || null,
    planExpiresAt: persistedUser.plan_expires_at || signedInUser.planExpiresAt || null,
    status: persistedUser.status || signedInUser.status || "active",
    premiumExpiresAt: persistedUser.premium_expires_at || signedInUser.premiumExpiresAt || null,
  };
}

function buildSearchHistoryMeta(planContext = {}) {
  return {
    enabled: canUseSearchHistory(planContext.code),
    retentionDays: Math.max(0, Number(planContext.searchHistoryRetentionDays || 0)),
    retentionLabel: getSearchHistoryRetentionLabel(planContext.code),
  };
}

async function getDashboardData() {
  const [uploadedChunkCount, suggestedQuestions] = await Promise.all([
    LawChatbotPdfChunkModel.countChunks(),
    LawChatbotSuggestedQuestionModel.listActive(18, "all"),
  ]);

  return {
    appName: "Coopbot Law Chatbot",
    description: "ระบบต้นแบบสำหรับค้นหากฎหมายสหกรณ์และกลุ่มเกษตรกร พร้อมเก็บคำถามและข้อเสนอแนะ",
    status: "Knowledge base ready",
    conversationCount: LawChatbotModel.count(),
    uploadedPdfCount: LawChatbotPdfChunkModel.countDocuments(),
    uploadedChunkCount,
    recentConversations: LawChatbotModel.listRecent(6),
    suggestedQuestions,
  };
}

async function getUserDashboardData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  if (!userId) {
    throw new Error("Please sign in before opening the user dashboard.");
  }

  const usageMonth = UserMonthlyUsageModel.getYearMonth();
  const [persistedUser, usage, recentRequests] = await Promise.all([
    UserModel.findById(userId),
    UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth),
    PaymentRequestModel.listByUserId(userId, 10),
  ]);

  const profile = buildSignedInProfile(signedInUser, persistedUser);
  const planContext = resolveUserPlanContext(profile);
  const questionCount = Number(usage?.question_count || 0);
  const aiPreview = buildAiPreviewMeta(planContext, usage);
  const questionLimit = Number.isFinite(planContext.monthlyLimit) ? planContext.monthlyLimit : null;
  const remainingQuestions =
    Number.isFinite(questionLimit) ? Math.max(0, questionLimit - questionCount) : null;

  return {
    appName: "Coopbot Law Chatbot",
    user: profile,
    planContext,
    usage: {
      usageMonth,
      questionCount,
      questionLimit,
      remainingQuestions,
      isUnlimited: planContext.isUnlimited,
    },
    aiPreview,
    searchHistory: buildSearchHistoryMeta(planContext),
    recentRequests: recentRequests.map((item) => enrichPaymentRequestRecord(item)),
  };
}

async function getUserSearchHistoryData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  if (!userId) {
    throw new Error("Please sign in before opening search history.");
  }

  const persistedUser = await UserModel.findById(userId);
  const profile = buildSignedInProfile(signedInUser, persistedUser);
  const planContext = resolveUserPlanContext(profile);
  const searchHistory = buildSearchHistoryMeta(planContext);
  await UserSearchHistoryModel.deleteExpired();
  const entries = await UserSearchHistoryModel.listActiveByUserId(userId, 100);

  return {
    appName: "Coopbot Law Chatbot",
    user: profile,
    planContext,
    searchHistory,
    entries,
  };
}

async function getPaymentRequestPageData(user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  const currentPlanContext = resolveUserPlanContext(signedInUser);
  const usageMonth = UserMonthlyUsageModel.getYearMonth();
  const usage = userId ? await UserMonthlyUsageModel.findByUserAndMonth(userId, usageMonth) : null;
  const aiPreview = buildAiPreviewMeta(currentPlanContext, usage);

  return {
    appName: "Coopbot Law Chatbot",
    plans: listPurchasablePlans(),
    planComparison: listPlanComparisons(),
    currentPlanContext,
    aiPreview,
    user: signedInUser,
    recentRequests: userId
      ? (await PaymentRequestModel.listByUserId(userId, 10)).map((item) => enrichPaymentRequestRecord(item))
      : [],
  };
}

async function submitPaymentRequest(payload, file, user) {
  const signedInUser = user || {};
  const userId = Number(signedInUser.userId || signedInUser.id || 0);
  const planCode = normalizePlanCode(payload.planName || "");
  const note = String(payload.note || "").trim();

  if (!userId) {
    throw new Error("Please sign in before submitting a payment request.");
  }

  if (!isPaidPlan(planCode)) {
    throw new Error("Please select a valid paid plan.");
  }

  const amount = getPlanPriceBaht(planCode);

  const paymentRequest = await PaymentRequestModel.create({
    userId,
    planName: planCode,
    amount,
    slipImage: file ? `/uploads/paymentRequests/${file.filename}` : "",
    note,
    status: "pending",
  });

  try {
    await sendPaymentRequestNotification(paymentRequest, signedInUser);
  } catch (error) {
    console.error("[submitPaymentRequest] Telegram notification failed:", error.message || error);
  }

  return paymentRequest;
}

async function getAdminUsersData(query = "", options = {}) {
  const trimmedQuery = String(query || "").trim();
  const requestedPage = normalizePageNumber(options.page || 1);
  const pageSize = normalizePageSize(options.pageSize || 12, 12, 50);
  const [stats, filteredTotalCount] = await Promise.all([
    UserModel.getAdminStats(),
    UserModel.countForAdmin(trimmedQuery),
  ]);
  const pagination = buildPaginationMeta({
    page: requestedPage,
    pageSize,
    totalItems: filteredTotalCount,
  });
  const users = await UserModel.listForAdmin({
    query: trimmedQuery,
    limit: pagination.pageSize,
    offset: pagination.offset,
  });

  return {
    query: trimmedQuery,
    totalCount: Number(stats.total_count || 0),
    freeCount: Number(stats.free_count || 0),
    paidCount: Number(stats.paid_count || 0),
    activeCount: Number(stats.active_count || 0),
    defaultPlanDurationDays: getPlanDurationDays(),
    plans: listAdminManageablePlans(),
    pagination,
    users: users.map((item) => enrichAdminUserRecord(item)),
  };
}

function maskIdentityHash(value = "") {
  const text = String(value || "");
  if (text.length <= 18) {
    return text;
  }

  return `${text.slice(0, 8)}...${text.slice(-8)}`;
}

function getIdentityTypeLabel(identityType = "") {
  switch (String(identityType || "").trim()) {
    case "cookie":
      return "Cookie ถาวร";
    case "network":
      return "เครือข่าย";
    case "device_hint":
      return "Device hint";
    default:
      return String(identityType || "-");
  }
}

function listGuestUsageIdentityTypes() {
  return [
    { value: "", label: "ทุกประเภท" },
    { value: "cookie", label: getIdentityTypeLabel("cookie") },
    { value: "network", label: getIdentityTypeLabel("network") },
    { value: "device_hint", label: getIdentityTypeLabel("device_hint") },
  ];
}

async function getAdminGuestUsageData(options = {}) {
  const usageMonth = String(options.usageMonth || GuestMonthlyUsageModel.getYearMonth()).trim();
  const query = String(options.query || "").trim();
  const identityType = String(options.identityType || "").trim().toLowerCase();
  const requestedPage = normalizePageNumber(options.page || 1);
  const pageSize = normalizePageSize(options.pageSize || 20, 20, 100);
  const [stats, filteredTotalCount] = await Promise.all([
    GuestMonthlyUsageModel.getAdminStats({ usageMonth, identityType, blockedThreshold: 2 }),
    GuestMonthlyUsageModel.countForAdmin({ usageMonth, query, identityType }),
  ]);
  const pagination = buildPaginationMeta({
    page: requestedPage,
    pageSize,
    totalItems: filteredTotalCount,
  });
  const records = await GuestMonthlyUsageModel.listForAdmin({
    usageMonth,
    query,
    identityType,
    limit: pagination.pageSize,
    offset: pagination.offset,
  });

  return {
    usageMonth,
    query,
    identityType,
    identityTypes: listGuestUsageIdentityTypes(),
    stats,
    pagination,
    records: records.map((item) => ({
      ...item,
      identityTypeLabel: getIdentityTypeLabel(item.identity_type),
      maskedIdentityHash: maskIdentityHash(item.identity_hash),
      isBlocked: Number(item.question_count || 0) >= 2,
    })),
  };
}

async function clearAdminGuestUsage(options = {}) {
  return GuestMonthlyUsageModel.deleteForAdmin({
    id: options.id,
    usageMonth: options.usageMonth,
    query: options.query,
    identityType: options.identityType,
  });
}

async function adminUpdateUserPlan(userId, planCode, options = {}) {
  const normalizedUserId = Number(userId || 0);
  const normalizedPlanCode = normalizePlanCode(planCode || "free");
  const allowedPlans = new Set(listAdminManageablePlans().map((plan) => plan.code));
  const durationDays = Math.max(
    1,
    Number(options.durationDays || getPlanDurationDays()),
  );

  if (!normalizedUserId) {
    return { ok: false, reason: "invalid_user" };
  }

  if (!allowedPlans.has(normalizedPlanCode)) {
    return { ok: false, reason: "invalid_plan" };
  }

  const currentUser = await UserModel.findById(normalizedUserId);
  if (!currentUser) {
    return { ok: false, reason: "not_found" };
  }

  const updated = await UserModel.setPlanByAdmin(normalizedUserId, normalizedPlanCode, {
    durationDays,
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  const refreshedUser = await UserModel.findById(normalizedUserId);
  const enrichedUser = enrichAdminUserRecord(refreshedUser || currentUser);

  return {
    ok: true,
    user: enrichedUser,
    planCode: normalizedPlanCode,
    planLabel: getPlanLabel(normalizedPlanCode),
    durationDays,
  };
}

async function getAdminPaymentRequestsData(options = {}) {
  const requestedPage = normalizePageNumber(options.page || 1);
  const pageSize = normalizePageSize(options.pageSize || 12, 12, 50);
  const stats = await PaymentRequestModel.getAdminStats();
  const pagination = buildPaginationMeta({
    page: requestedPage,
    pageSize,
    totalItems: Number(stats.total_count || 0),
  });
  const requests = (await PaymentRequestModel.listAll({
    limit: pagination.pageSize,
    offset: pagination.offset,
  })).map((item) => enrichPaymentRequestRecord(item));

  return {
    plans: listPurchasablePlans(),
    totalCount: Number(stats.total_count || 0),
    pendingCount: Number(stats.pending_count || 0),
    approvedCount: Number(stats.approved_count || 0),
    rejectedCount: Number(stats.rejected_count || 0),
    pagination,
    requests,
  };
}

async function getAdminPaymentRequestDetail(id) {
  const request = await PaymentRequestModel.findById(id);
  if (!request) {
    return null;
  }

  return {
    request: enrichPaymentRequestRecord(request),
    plans: listPurchasablePlans(),
  };
}

async function updatePaymentRequestPlan(id, nextPlanCode) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }

  const currentPlanCode = normalizePlanCode(request.plan_name || "free");
  const planCode = normalizePlanCode(nextPlanCode || currentPlanCode);
  if (!isPaidPlan(planCode)) {
    return { ok: false, reason: "invalid_plan" };
  }

  const amount = getPlanPriceBaht(planCode);
  if (currentPlanCode === planCode && Number(request.amount || 0) === amount) {
    return {
      ok: true,
      requestId: Number(request.id || id || 0),
      planCode,
      planLabel: getPlanLabel(planCode),
      amount,
      unchanged: true,
    };
  }

  const updated = await PaymentRequestModel.updateRequestedPlan(id, planCode, amount);
  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  return {
    ok: true,
    requestId: Number(request.id || id || 0),
    planCode,
    planLabel: getPlanLabel(planCode),
    amount,
    previousPlanCode: currentPlanCode,
    previousPlanLabel: getPlanLabel(currentPlanCode),
  };
}

async function approvePaymentRequest(id, reviewMeta = {}) {
  const pool = getDbPool();
  if (!pool) {
    throw new Error("Database connection is required for payment approval.");
  }

  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const request = await findPendingPaymentRequestByIdForUpdate(connection, id);
    if (!request) {
      await connection.rollback();
      return { ok: false, reason: "not_found" };
    }

    const planCode = normalizePlanCode(request.plan_name || "free");
    if (!isPaidPlan(planCode)) {
      await connection.rollback();
      return { ok: false, reason: "invalid_plan" };
    }

    const activated = await activatePlanWithConnection(connection, request.user_id, planCode, {
      durationDays: getPlanDurationDays(),
    });
    if (!activated) {
      await connection.rollback();
      return { ok: false, reason: "user_not_updated" };
    }

    const [reviewResult] = await connection.query(
      `UPDATE payment_requests
       SET status = 'approved',
           reviewed_at = CURRENT_TIMESTAMP,
           reviewed_by = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'pending'`,
      [String(reviewMeta.reviewedBy || "").trim() || null, Number(id || 0)]
    );

    if (reviewResult.affectedRows <= 0) {
      await connection.rollback();
      return { ok: false, reason: "review_not_updated" };
    }

    await connection.commit();

    return {
      ok: true,
      requestId: id,
      planCode,
      planLabel: getPlanLabel(planCode),
    };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function rejectPaymentRequest(id, reviewMeta = {}) {
  const request = await PaymentRequestModel.findById(id);
  if (!request || request.status !== "pending") {
    return { ok: false, reason: "not_found" };
  }
  const planCode = normalizePlanCode(request.plan_name || "free");

  const reviewed = await PaymentRequestModel.updateReviewStatus(
    id,
    "rejected",
    reviewMeta.reviewedBy || "",
  );

  if (!reviewed) {
    return { ok: false, reason: "review_not_updated" };
  }

  return {
    ok: true,
    requestId: id,
    planCode,
    planLabel: getPlanLabel(planCode),
  };
}

module.exports = {
  adminUpdateUserPlan,
  approvePaymentRequest,
  clearAdminGuestUsage,
  getAdminGuestUsageData,
  getAdminPaymentRequestDetail,
  getAdminPaymentRequestsData,
  getAdminUsersData,
  getDashboardData,
  getPaymentRequestPageData,
  getUserDashboardData,
  getUserSearchHistoryData,
  rejectPaymentRequest,
  submitPaymentRequest,
  updatePaymentRequestPlan,
};
