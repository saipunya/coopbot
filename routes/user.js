const express = require("express");

const userController = require("../controllers/userController");
const { requireGoogleUser } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/", requireGoogleUser, userController.renderDashboard);
router.post("/logout", requireGoogleUser, userController.logout);

module.exports = router;
