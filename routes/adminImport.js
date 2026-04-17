const express = require("express");
const uploadDocx = require("../middlewares/adminDocxUpload");
const adminImportController = require("../controllers/adminImportController");
const { requireAdminAuth } = require("../middlewares/authMiddleware");

const router = express.Router();

function runUploadMiddleware(req, res, next) {
  const middleware = uploadDocx.fields([
    { name: "file", maxCount: 1 },
    { name: "docx", maxCount: 1 },
  ]);

  middleware(req, res, (error) => {
    if (error) {
      return res.status(400).json({
        ok: false,
        message: error.message || "DOCX upload failed.",
      });
    }

    return next();
  });
}

router.post("/import/docx", requireAdminAuth, runUploadMiddleware, adminImportController.importDocx);
router.get("/import/search-test", requireAdminAuth, adminImportController.searchTest);

module.exports = router;
