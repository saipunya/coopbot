const express = require("express");

const { requireAdminAuth } = require("../middlewares/authMiddleware");
const importController = require("../controllers/importController");

const router = express.Router();

router.get("/import/qa-bulk", requireAdminAuth, importController.renderQaBulkImportForm);
router.post("/import/qa-bulk/preview", requireAdminAuth, importController.previewQaBulkImport);
router.post("/import/qa-bulk/save", requireAdminAuth, importController.saveQaBulkImport);

module.exports = router;
