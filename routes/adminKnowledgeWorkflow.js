const express = require("express");

const controller = require("../controllers/knowledgeWorkflowController");
const { requireAdminAuth } = require("../middlewares/authMiddleware");

const router = express.Router();

function wantsJsonResponse(req) {
  const acceptHeader = String(req?.headers?.accept || "").toLowerCase();
  return Boolean(
    req?.xhr ||
      req?.is?.("application/json") ||
      acceptHeader.includes("application/json")
  );
}

function requireAdminWorkflowAuth(req, res, next) {
  if (req.session?.adminUser) {
    req.user = req.session.adminUser;
    res.locals.currentUser = req.user;
    return next();
  }

  if (wantsJsonResponse(req)) {
    return res.status(401).json({
      ok: false,
      reason: "admin_auth_required",
      message: "กรุณาเข้าสู่ระบบผู้ดูแลก่อนใช้งาน",
      loginPath: "/admin/login",
    });
  }

  return requireAdminAuth(req, res, next);
}

router.use(requireAdminWorkflowAuth);

router.post("/knowledge-sources", controller.createSource);
router.post("/knowledge-sources/:id/generate-drafts", controller.generateDrafts);
router.get("/knowledge-sources/:id/drafts", controller.listDraftsBySource);
router.post("/knowledge-drafts/:id/approve-suggested", controller.approveDraftToSuggestedQuestion);
router.post("/knowledge-drafts/:id/approve-knowledge", controller.approveDraftToKnowledge);
router.post("/knowledge-drafts/:id/reject", controller.rejectDraft);

module.exports = router;
