const express = require("express");

const controller = require("../controllers/adminSearchMissController");
const { requireAdminAuth } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/search-misses", requireAdminAuth, controller.renderSearchMisses);
router.get("/search-misses/new-faq", requireAdminAuth, controller.renderNewFaq);
router.post("/search-misses/new-faq", requireAdminAuth, controller.createFaq);
router.post("/search-misses/delete", requireAdminAuth, controller.deleteQuery);

module.exports = router;
