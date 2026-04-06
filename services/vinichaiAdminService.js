const VinichaiModel = require("../models/vinichaiModel");
const { clearAnswerCache } = require("./answerStateService");
const { buildPaginationMeta, normalizePageNumber, normalizePageSize } = require("./paginationUtils");

function normalizeVinichaiPayload(payload = {}) {
  return {
    vinGroup: String(payload.vinGroup || payload.vin_group || "").trim(),
    vinKey: String(payload.vinKey || payload.vin_key || "").trim(),
    vinQuestion: String(payload.vinQuestion || payload.vin_question || "").trim(),
    vinDetail: String(payload.vinDetail || payload.vin_detail || "").trim(),
    vinMaihed: String(payload.vinMaihed || payload.vin_maihed || "").trim(),
    vinSavedate: String(payload.vinSavedate || payload.vin_savedate || "").trim(),
  };
}

function getVinichaiSaveBy(meta = {}) {
  return String(meta.saveBy || meta.savedBy || meta.updatedBy || meta.createdBy || "admin").trim() || "admin";
}

async function getVinichaiAdminData(options = {}) {
  const query = String(options.query || "").trim();
  const page = normalizePageNumber(options.page || 1);
  const pageSize = normalizePageSize(options.pageSize || 12, 12, 50);
  const totalCount = await VinichaiModel.countForAdmin(query);
  const pagination = buildPaginationMeta({
    page,
    pageSize,
    totalItems: totalCount,
  });

  const entries = await VinichaiModel.listForAdmin({
    query,
    limit: pagination.pageSize,
    offset: pagination.offset,
  });

  return {
    appName: "Coopbot Law Chatbot",
    query,
    totalCount,
    pagination,
    entries,
  };
}

async function saveVinichaiEntry(payload = {}, meta = {}) {
  const normalized = normalizeVinichaiPayload(payload);
  if (!normalized.vinGroup || !normalized.vinKey || !normalized.vinQuestion || !normalized.vinDetail || !normalized.vinMaihed) {
    return { ok: false, reason: "invalid_payload" };
  }

  const entry = await VinichaiModel.create(normalized, {
    saveBy: getVinichaiSaveBy(meta),
    vinSavedate: normalized.vinSavedate || meta.vinSavedate || meta.savedate || "",
  });

  clearAnswerCache();

  return {
    ok: true,
    entry,
  };
}

async function updateVinichaiEntry(id, payload = {}, meta = {}) {
  const existing = await VinichaiModel.findById(id);
  if (!existing) {
    return { ok: false, reason: "not_found" };
  }

  const normalized = normalizeVinichaiPayload({
    ...existing,
    ...payload,
  });

  if (!normalized.vinGroup || !normalized.vinKey || !normalized.vinQuestion || !normalized.vinDetail || !normalized.vinMaihed) {
    return { ok: false, reason: "invalid_payload" };
  }

  const updated = await VinichaiModel.updateById(id, normalized, {
    saveBy: getVinichaiSaveBy(meta),
    vinSavedate: normalized.vinSavedate || meta.vinSavedate || meta.savedate || existing.vinSavedate,
  });

  if (!updated) {
    return { ok: false, reason: "not_updated" };
  }

  clearAnswerCache();

  const refreshed = await VinichaiModel.findById(id);
  return {
    ok: true,
    entry: refreshed,
  };
}

async function deleteVinichaiEntry(id) {
  const removed = await VinichaiModel.removeById(id);
  if (removed) {
    clearAnswerCache();
  }
  return removed;
}

module.exports = {
  deleteVinichaiEntry,
  getVinichaiAdminData,
  saveVinichaiEntry,
  updateVinichaiEntry,
};
