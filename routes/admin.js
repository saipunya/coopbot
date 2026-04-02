const express = require("express");

const adminController = require("../controllers/adminController");
const {
  redirectIfAuthenticated,
  requireAdminAuth,
} = require("../middlewares/authMiddleware");

const router = express.Router();

function redirectLegacyGoogleAuthPath(targetPath) {
  return (req, res) => {
    const queryIndex = req.originalUrl.indexOf("?");
    const queryString = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : "";
    return res.redirect(`${targetPath}${queryString}`);
  };
}

router.get("/login", redirectIfAuthenticated, adminController.renderLogin);
router.post("/login", redirectIfAuthenticated, adminController.submitLogin);
router.get("/auth/google", redirectLegacyGoogleAuthPath("/auth/google"));
router.get("/auth/google/callback", redirectLegacyGoogleAuthPath("/auth/google/callback"));
router.get("/", requireAdminAuth, adminController.renderDashboard);
router.get("/users", requireAdminAuth, adminController.renderUsers);
router.post("/users/update-plan", requireAdminAuth, adminController.updateUserPlan);
router.get("/payment-requests", requireAdminAuth, adminController.renderPaymentRequests);
router.get("/payment-requests/:id", requireAdminAuth, adminController.renderPaymentRequestDetail);
router.post("/payment-requests/update-plan", requireAdminAuth, adminController.updatePaymentRequestPlan);
router.post("/payment-requests/approve", requireAdminAuth, adminController.approvePaymentRequest);
router.post("/payment-requests/reject", requireAdminAuth, adminController.rejectPaymentRequest);
router.post("/settings/ai", requireAdminAuth, adminController.updateAiSetting);
router.post("/knowledge", requireAdminAuth, adminController.submitKnowledge);
router.post("/knowledge/update", requireAdminAuth, adminController.updateKnowledge);
router.post("/knowledge/delete", requireAdminAuth, adminController.deleteKnowledge);
router.post("/knowledge-suggestions/update", requireAdminAuth, adminController.updateKnowledgeSuggestion);
router.post("/knowledge-suggestions/approve", requireAdminAuth, adminController.approveKnowledgeSuggestion);
router.post("/knowledge-suggestions/reject", requireAdminAuth, adminController.rejectKnowledgeSuggestion);
router.post("/logout", requireAdminAuth, adminController.logout);

module.exports = router;
