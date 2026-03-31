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
router.post("/knowledge", requireAdminAuth, adminController.submitKnowledge);
router.post("/knowledge/delete", requireAdminAuth, adminController.deleteKnowledge);
router.post("/logout", requireAdminAuth, adminController.logout);

module.exports = router;
