const express = require("express");

const adminController = require("../controllers/adminController");
const {
  redirectIfAuthenticated,
  requireAdminAuth,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/login", redirectIfAuthenticated, adminController.renderLogin);
router.post("/login", redirectIfAuthenticated, adminController.submitLogin);
router.get("/auth/google", redirectIfAuthenticated, adminController.redirectToGoogleLogin);
router.get("/auth/google/callback", redirectIfAuthenticated, adminController.handleGoogleCallback);
router.get("/", requireAdminAuth, adminController.renderDashboard);
router.get("/payment-requests", requireAdminAuth, adminController.renderPaymentRequests);
router.get("/payment-requests/:id", requireAdminAuth, adminController.renderPaymentRequestDetail);
router.post("/payment-requests/approve", requireAdminAuth, adminController.approvePaymentRequest);
router.post("/payment-requests/reject", requireAdminAuth, adminController.rejectPaymentRequest);
router.post("/knowledge", requireAdminAuth, adminController.submitKnowledge);
router.post("/knowledge/delete", requireAdminAuth, adminController.deleteKnowledge);
router.post("/knowledge-suggestions/approve", requireAdminAuth, adminController.approveKnowledgeSuggestion);
router.post("/knowledge-suggestions/reject", requireAdminAuth, adminController.rejectKnowledgeSuggestion);
router.post("/logout", requireAdminAuth, adminController.logout);

module.exports = router;
