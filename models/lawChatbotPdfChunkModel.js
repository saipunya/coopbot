const uploadedFiles = [];

class LawChatbotPdfChunkModel {
  static create(entry) {
    const record = {
      id: uploadedFiles.length + 1,
      createdAt: new Date().toISOString(),
      ...entry,
    };

    uploadedFiles.unshift(record);
    return record;
  }

  static countDocuments() {
    return uploadedFiles.length;
  }

  static list(limit = 10) {
    return uploadedFiles.slice(0, limit);
  }
}

module.exports = LawChatbotPdfChunkModel;
