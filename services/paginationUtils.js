function normalizePageNumber(value, defaultPage = 1) {
  const normalized = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(normalized) || normalized < 1) {
    return defaultPage;
  }

  return normalized;
}

function normalizePageSize(value, defaultSize = 10, maxSize = 200) {
  const normalized = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isFinite(normalized) || normalized < 1) {
    return Math.max(1, defaultSize);
  }

  return Math.max(1, Math.min(maxSize, normalized));
}

function buildPaginationMeta({ page = 1, pageSize = 10, totalItems = 0 } = {}) {
  const normalizedPageSize = normalizePageSize(pageSize, 10, 5000);
  const normalizedTotalItems = Math.max(0, Number(totalItems || 0));
  const totalPages = Math.max(1, Math.ceil(normalizedTotalItems / normalizedPageSize) || 1);
  const currentPage = Math.min(Math.max(1, normalizePageNumber(page, 1)), totalPages);
  const offset = (currentPage - 1) * normalizedPageSize;

  return {
    page: currentPage,
    pageSize: normalizedPageSize,
    totalItems: normalizedTotalItems,
    totalPages,
    hasPrev: currentPage > 1,
    hasNext: currentPage < totalPages,
    prevPage: currentPage > 1 ? currentPage - 1 : 1,
    nextPage: currentPage < totalPages ? currentPage + 1 : totalPages,
    offset,
    startItem: normalizedTotalItems === 0 ? 0 : offset + 1,
    endItem: Math.min(normalizedTotalItems, offset + normalizedPageSize),
  };
}

module.exports = {
  buildPaginationMeta,
  normalizePageNumber,
  normalizePageSize,
};