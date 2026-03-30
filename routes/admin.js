const express = require("express");

const adminController = require("../controllers/adminController");
const {
  redirectIfAuthenticated,
  requireAdminAuth,
} = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/login", redirectIfAuthenticated, adminController.renderLogin);
router.post("/login", redirectIfAuthenticated, adminController.submitLogin);
router.get("/", requireAdminAuth, adminController.renderDashboard);
router.post("/logout", requireAdminAuth, adminController.logout);

module.exports = router;
