const {
  buildQaBulkPreviewRows,
  saveQaBulkPreviewRows,
} = require("../services/qaImportService");

const VIEW_NAME = "import/qaBulk";
const DEFAULT_DOMAIN = "legal";
const DEFAULT_TARGET = "all";

function normalizeFormValue(value, fallback = "") {
  return String(value || fallback).trim();
}

function renderQaBulkImportForm(req, res, viewModel = {}) {
  return res.render(VIEW_NAME, {
    title: "Bulk Import Q&A",
    user: req.session.adminUser,
    errorMessage: req.query.error || viewModel.errorMessage || "",
    successMessage: req.query.success || viewModel.successMessage || "",
    form: {
      qaText: viewModel.qaText || "",
      sourceReference: viewModel.sourceReference || "",
      domain: viewModel.domain || DEFAULT_DOMAIN,
      target: viewModel.target || DEFAULT_TARGET,
    },
    previewRows: viewModel.previewRows || [],
    previewRowsJson: viewModel.previewRowsJson || "",
  });
}

function parsePreviewRowsJson(rawValue) {
  const text = normalizeFormValue(rawValue);
  if (!text) {
    return [];
  }

  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error("Preview payload is invalid.");
  }

  return parsed;
}

async function previewQaBulkImport(req, res) {
  const qaText = normalizeFormValue(req.body.qa_text);
  const sourceReference = normalizeFormValue(req.body.source_reference);
  const domain = normalizeFormValue(req.body.domain, DEFAULT_DOMAIN) || DEFAULT_DOMAIN;
  const target = normalizeFormValue(req.body.target, DEFAULT_TARGET) || DEFAULT_TARGET;

  try {
    const previewRows = buildQaBulkPreviewRows({
      qaText,
      sourceReference,
      domain,
      target,
    });

    return renderQaBulkImportForm(req, res, {
      qaText,
      sourceReference,
      domain,
      target,
      previewRows,
      previewRowsJson: JSON.stringify(previewRows),
      successMessage: `แยก Q&A ได้ ${previewRows.length} รายการ`,
    });
  } catch (error) {
    return renderQaBulkImportForm(req, res, {
      qaText,
      sourceReference,
      domain,
      target,
      errorMessage: error.message || "ไม่สามารถแยก Q&A ได้",
    });
  }
}

async function saveQaBulkImport(req, res) {
  const qaText = normalizeFormValue(req.body.qa_text);
  const sourceReference = normalizeFormValue(req.body.source_reference);
  const domain = normalizeFormValue(req.body.domain, DEFAULT_DOMAIN) || DEFAULT_DOMAIN;
  const target = normalizeFormValue(req.body.target, DEFAULT_TARGET) || DEFAULT_TARGET;

  let previewRows = [];

  try {
    previewRows = parsePreviewRowsJson(req.body.preview_rows_json);
    if (!previewRows.length && qaText) {
      previewRows = buildQaBulkPreviewRows({
        qaText,
        sourceReference,
        domain,
        target,
      });
    }
  } catch (error) {
    return renderQaBulkImportForm(req, res, {
      qaText,
      sourceReference,
      domain,
      target,
      errorMessage: error.message || "ข้อมูล preview ไม่ถูกต้อง",
    });
  }

  if (!previewRows.length) {
    return renderQaBulkImportForm(req, res, {
      qaText,
      sourceReference,
      domain,
      target,
      errorMessage: "ไม่พบรายการ Q&A สำหรับบันทึก",
    });
  }

  try {
    const result = await saveQaBulkPreviewRows(previewRows);
    const successMessage = `บันทึก Q&A แบบ bulk สำเร็จ ${result.insertedRows} รายการ`;

    return res.redirect(`/import/qa-bulk?success=${encodeURIComponent(successMessage)}`);
  } catch (error) {
    return renderQaBulkImportForm(req, res, {
      qaText,
      sourceReference,
      domain,
      target,
      previewRows,
      previewRowsJson: JSON.stringify(previewRows),
      errorMessage: error.message || "ไม่สามารถบันทึก Q&A ได้",
    });
  }
}

module.exports = {
  renderQaBulkImportForm,
  previewQaBulkImport,
  saveQaBulkImport,
};
