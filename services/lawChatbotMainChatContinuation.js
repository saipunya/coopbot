const crypto = require("node:crypto");

const LawChatbotModel = require("../models/lawChatbotModel");
const LawChatbotKnowledgeModel = require("../models/lawChatbotKnowledgeModel");
const LawChatbotKnowledgeSuggestionModel = require("../models/lawChatbotKnowledgeSuggestionModel");
const LawChatbotPdfChunkModel = require("../models/lawChatbotPdfChunkModel");
const LawSearchModel = require("../models/lawSearchModel");

const MAIN_CHAT_CONTINUATION_MAX_CHARACTERS = 1200;
const MAIN_CHAT_CONTINUATION_MAX_SOURCE_CHUNKS = 2;
const MAIN_CHAT_CONTINUATION_SOURCE_LIMIT = 12;
const MAIN_CHAT_CONTINUATION_TOKEN_TTL_MS = 60 * 60 * 1000;
const MAIN_CHAT_CONTINUATION_VERSION = 1;
const MAIN_CHAT_CONTINUATION_SESSION_KEY = "lawChatbotMainChatContinuation";

function normalizeContinuationText(text = "") {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const paddingLength = (4 - (normalized.length % 4 || 4)) % 4;
  return Buffer.from(`${normalized}${"=".repeat(paddingLength)}`, "base64");
}

function getContinuationSecret() {
  return String(
    process.env.LAW_CHATBOT_CONTINUATION_SECRET ||
      process.env.SESSION_SECRET ||
      "law-chatbot-main-chat-continuation",
  ).trim();
}

function signPayload(serializedPayload) {
  return crypto
    .createHmac("sha256", getContinuationSecret())
    .update(serializedPayload)
    .digest();
}

function buildTokenPayload(state = {}) {
  return {
    v: MAIN_CHAT_CONTINUATION_VERSION,
    exp: Date.now() + MAIN_CHAT_CONTINUATION_TOKEN_TTL_MS,
    target: String(state.target || "all").trim() || "all",
    aid: String(state.answerInstanceId || "").trim(),
    // include original message to allow token-only continuation resumes
    q: String(state.originalMessage || "").trim(),
    idx: Math.max(0, Number(state.activeSourceIndex || 0)),
    src: (Array.isArray(state.sources) ? state.sources : [])
      .slice(0, MAIN_CHAT_CONTINUATION_SOURCE_LIMIT)
      .map((source) => ({
        s: String(source.source || "").trim(),
        i: source.id || null,
        d: source.documentId || null,
        m: String(source.continuationMode || "").trim(),
        n: Math.max(0, Number(source.continuationNextOffset || source.continuationCursor || 0)),
        c: source.continuationChunkId || null,
        o: Math.max(0, Number(source.continuationChunkOffset || 0)),
        t: Math.max(0, Number(source.continuationTotalLength || 0)),
        h: source.continuationHasMore === true,
      })),
  };
}

function buildStateFromTokenPayload(payload = {}) {
  return {
    answerInstanceId: String(payload.aid || "").trim(),
    target: String(payload.target || "all").trim() || "all",
    originalMessage: String(payload.q || "").trim(),
    effectiveMessage: String(payload.q || "").trim(),
    activeSourceIndex: Math.max(0, Number(payload.idx || 0)),
    sources: (Array.isArray(payload.src) ? payload.src : []).map((source) => ({
      source: String(source.s || "").trim(),
      id: source.i || null,
      documentId: source.d || null,
      continuationMode: String(source.m || "").trim(),
      continuationNextOffset: Math.max(0, Number(source.n || 0)),
      continuationChunkId: source.c || null,
      continuationChunkOffset: Math.max(0, Number(source.o || 0)),
      continuationTotalLength: Math.max(0, Number(source.t || 0)),
      continuationHasMore: source.h === true,
    })),
  };
}

function signContinuationToken(state = {}) {
  const payload = buildTokenPayload(state);
  const serializedPayload = JSON.stringify(payload);
  const encodedPayload = base64UrlEncode(serializedPayload);
  const signature = signPayload(serializedPayload);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

function verifyContinuationToken(token, expectedTarget = "") {
  const rawToken = String(token || "").trim();
  if (!rawToken) {
    throw new Error("missing continuation token");
  }

  const parts = rawToken.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("invalid continuation token format");
  }

  const payloadBuffer = base64UrlDecode(parts[0]);
  const signatureBuffer = base64UrlDecode(parts[1]);
  const expectedSignature = signPayload(payloadBuffer);

  if (
    signatureBuffer.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedSignature)
  ) {
    throw new Error("invalid continuation token signature");
  }

  const payload = JSON.parse(payloadBuffer.toString("utf8"));
  if (Number(payload.v || 0) !== MAIN_CHAT_CONTINUATION_VERSION) {
    throw new Error("unsupported continuation token version");
  }

  if (Math.max(0, Number(payload.exp || 0)) <= Date.now()) {
    throw new Error("expired continuation token");
  }

  const normalizedExpectedTarget = String(expectedTarget || "").trim();
  const tokenTarget = String(payload.target || "").trim();
  if (
    normalizedExpectedTarget &&
    normalizedExpectedTarget !== "all" &&
    tokenTarget !== normalizedExpectedTarget
  ) {
    throw new Error("continuation token target mismatch");
  }

  return buildStateFromTokenPayload(payload);
}

function resolveContinuationState(options = {}) {
  const target = String(options.target || "all").trim() || "all";
  const continuationToken = String(options.continuationToken || "").trim();
  const sessionState = options.sessionState || null;

  if (continuationToken) {
    const tokenState = verifyContinuationToken(continuationToken, target);
    // If sessionState exists and matches the same answerInstanceId, prefer the richer session state
    if (sessionState && String(sessionState.answerInstanceId || "").trim() === String(tokenState.answerInstanceId || "").trim()) {
      return {
        state: sessionState,
        source: "token",
      };
    }

    return {
      state: tokenState,
      source: "token",
    };
  }

  if (sessionState && sessionState.target === target) {
    return {
      state: sessionState,
      source: "session",
    };
  }

  return {
    state: null,
    source: "",
  };
}

function buildContinuationSourceState(source = {}) {
  const sourceName = String(source.source || "").trim().toLowerCase();
  const documentId = Number(
    source.documentId ||
      source.document_id ||
      (sourceName === "documents" ? source.id || 0 : 0),
  );
  const chunkId =
    source.continuationChunkId ||
    (sourceName === "pdf_chunks" ? source.id || null : null);
  const continuationMode =
    source.continuationMode ||
    (sourceName === "documents" || sourceName === "pdf_chunks"
      ? "document_chunks"
      : "text");

  return {
    source: source.source || "",
    id: source.id || null,
    documentId: documentId > 0 ? documentId : null,
    title: source.title || "",
    reference: source.reference || source.title || "",
    lawNumber: source.lawNumber || "",
    url: source.url || "",
    keyword: source.keyword || "",
    content: source.content || source.chunk_text || source.comment || "",
    continuationMode,
    continuationCursor: Math.max(0, Number(source.continuationCursor || 0)),
    continuationNextOffset: Math.max(
      0,
      Number(source.continuationNextOffset || source.continuationCursor || 0),
    ),
    continuationChunkId: chunkId || null,
    continuationChunkOffset: Math.max(0, Number(source.continuationChunkOffset || 0)),
    continuationTotalLength: Math.max(0, Number(source.continuationTotalLength || 0)),
    continuationHasMore:
      typeof source.continuationHasMore === "boolean"
        ? source.continuationHasMore
        : Boolean(source.id || documentId || source.content || source.chunk_text || source.comment),
  };
}

function createContinuationSessionState(options = {}) {
  return {
    answerInstanceId: crypto.randomUUID(),
    target: String(options.target || "all").trim() || "all",
    originalMessage: String(options.originalMessage || "").trim(),
    effectiveMessage: String(options.effectiveMessage || options.originalMessage || "").trim(),
    activeSourceIndex: 0,
    sources: (Array.isArray(options.sources) ? options.sources : [])
      .slice(0, MAIN_CHAT_CONTINUATION_SOURCE_LIMIT)
      .map((source) => buildContinuationSourceState(source)),
  };
}

function getSessionContinuationState(session) {
  if (!session || typeof session !== "object") {
    return null;
  }

  const state = session[MAIN_CHAT_CONTINUATION_SESSION_KEY];
  if (!state || typeof state !== "object") {
    return null;
  }

  return {
    answerInstanceId: String(state.answerInstanceId || "").trim(),
    target: String(state.target || "all").trim() || "all",
    originalMessage: String(state.originalMessage || "").trim(),
    effectiveMessage: String(state.effectiveMessage || state.originalMessage || "").trim(),
    activeSourceIndex: Math.max(0, Number(state.activeSourceIndex || 0)),
    sources: (Array.isArray(state.sources) ? state.sources : [])
      .slice(0, MAIN_CHAT_CONTINUATION_SOURCE_LIMIT)
      .map((source) => buildContinuationSourceState(source)),
  };
}

function setSessionContinuationState(session, state = null) {
  if (!session || typeof session !== "object") {
    return;
  }

  if (!state) {
    delete session[MAIN_CHAT_CONTINUATION_SESSION_KEY];
    return;
  }

  session[MAIN_CHAT_CONTINUATION_SESSION_KEY] = {
    answerInstanceId: String(state.answerInstanceId || "").trim(),
    target: String(state.target || "all").trim() || "all",
    originalMessage: String(state.originalMessage || "").trim(),
    effectiveMessage: String(state.effectiveMessage || state.originalMessage || "").trim(),
    activeSourceIndex: Math.max(0, Number(state.activeSourceIndex || 0)),
    sources: (Array.isArray(state.sources) ? state.sources : [])
      .slice(0, MAIN_CHAT_CONTINUATION_SOURCE_LIMIT)
      .map((source) => buildContinuationSourceState(source)),
  };
}

async function hydrateTextSource(source = {}) {
  const sourceName = String(source.source || "").trim().toLowerCase();
  const normalizedId = Number(source.id || 0);
  let record = null;

  if (sourceName === "admin_knowledge" && normalizedId) {
    record = await LawChatbotKnowledgeModel.findById(normalizedId);
  } else if (sourceName === "knowledge_suggestion" && normalizedId) {
    record = await LawChatbotKnowledgeSuggestionModel.findById(normalizedId);
  } else if (sourceName === "knowledge_base" && normalizedId) {
    record = await LawChatbotModel.findKnowledgeById(normalizedId);
  } else if (["tbl_laws", "tbl_glaws", "tbl_vinichai"].includes(sourceName) && normalizedId) {
    record = await LawSearchModel.findBySourceId(sourceName, normalizedId);
  } else if (sourceName === "pdf_chunks" && normalizedId) {
    record = await LawChatbotPdfChunkModel.findChunkById(normalizedId);
  }

  return {
    ...(record && typeof record === "object" ? record : {}),
    source: source.source || record?.source || "",
    id: record?.id || source.id || null,
    documentId: record?.documentId || record?.document_id || source.documentId || null,
    reference: record?.reference || record?.title || source.reference || source.title || "",
    title: record?.title || source.title || "",
    lawNumber: record?.lawNumber || source.lawNumber || "",
    url: record?.url || source.url || "",
    keyword: record?.keyword || source.keyword || "",
    content: record?.content || source.content || "",
    chunk_text: record?.chunk_text || source.chunk_text || "",
    comment: record?.comment || source.comment || "",
  };
}

async function sliceTextSource(source = {}, options = {}) {
  const remainingCharacters = Math.max(0, Number(options.remainingCharacters || 0));
  if (remainingCharacters <= 0) {
    return null;
  }

  const record = await hydrateTextSource(source);
  const fullText = normalizeContinuationText(
    [record.content, record.chunk_text, record.comment]
      .filter(Boolean)
      .join(" "),
  );
  const currentOffset = Math.max(
    0,
    Number(source.continuationNextOffset || source.continuationCursor || 0),
  );

  if (!fullText || currentOffset >= fullText.length) {
    return {
      renderSource: null,
      nextSource: {
        ...source,
        continuationTotalLength: fullText.length,
        continuationHasMore: false,
      },
      charactersUsed: 0,
      chunksUsed: 0,
      hasMoreInSource: false,
    };
  }

  const rawSlice = fullText.slice(currentOffset, currentOffset + remainingCharacters);
  const nextOffset = Math.min(fullText.length, currentOffset + rawSlice.length);
  const renderText = normalizeContinuationText(rawSlice);

  return {
    renderSource: renderText
      ? {
          ...record,
          source: source.source || record.source || "",
          id: record.id || source.id || null,
          documentId: record.documentId || record.document_id || source.documentId || null,
          content: renderText,
          comment: "",
          score: Number(options.score || 0),
        }
      : null,
    nextSource: {
      ...source,
      continuationCursor: currentOffset,
      continuationNextOffset: nextOffset,
      continuationTotalLength: fullText.length,
      continuationHasMore: nextOffset < fullText.length,
    },
    charactersUsed: rawSlice.length,
    chunksUsed: renderText ? 1 : 0,
    hasMoreInSource: nextOffset < fullText.length,
  };
}

async function fetchNextDocumentChunks(documentId, afterChunkId, limit) {
  if (!Number(documentId || 0) || limit <= 0) {
    return [];
  }

  return LawChatbotPdfChunkModel.listChunksByDocumentId(documentId, {
    afterChunkId: Math.max(0, Number(afterChunkId || 0)),
    limit,
  });
}

async function sliceDocumentSource(source = {}, options = {}) {
  let remainingCharacters = Math.max(0, Number(options.remainingCharacters || 0));
  let remainingChunks = Math.max(0, Number(options.remainingChunks || 0));

  if (remainingCharacters <= 0 || remainingChunks <= 0) {
    return null;
  }

  const documentId = Number(
    source.documentId ||
      (source.source === "documents" ? source.id || 0 : 0),
  );
  let currentChunkId = Number(
    source.continuationChunkId ||
      (source.source === "pdf_chunks" ? source.id || 0 : 0),
  );
  let currentChunkOffset = Math.max(0, Number(source.continuationChunkOffset || 0));
  let currentChunkLength = Math.max(0, Number(source.continuationTotalLength || 0));
  const pieces = [];
  let chunksUsed = 0;
  let charactersUsed = 0;
  let activeRecord = null;

  const appendChunk = (chunk, startOffset = 0) => {
    if (!chunk || remainingCharacters <= 0 || remainingChunks <= 0) {
      return false;
    }

    const chunkText = normalizeContinuationText(chunk.content || chunk.chunk_text || "");
    if (!chunkText || startOffset >= chunkText.length) {
      return false;
    }

    const rawSlice = chunkText.slice(startOffset, startOffset + remainingCharacters);
    const normalizedSlice = normalizeContinuationText(rawSlice);
    if (!normalizedSlice) {
      return false;
    }

    pieces.push(normalizedSlice);
    activeRecord = activeRecord || chunk;
    currentChunkId = Number(chunk.id || currentChunkId || 0);
    currentChunkLength = chunkText.length;
    currentChunkOffset = Math.min(chunkText.length, startOffset + rawSlice.length);
    remainingCharacters = Math.max(0, remainingCharacters - rawSlice.length);
    remainingChunks -= 1;
    charactersUsed += rawSlice.length;
    chunksUsed += 1;
    return true;
  };

  if (currentChunkId > 0) {
    const currentChunk = await LawChatbotPdfChunkModel.findChunkById(currentChunkId);
    appendChunk(currentChunk, currentChunkOffset);
  }

  if (pieces.length === 0 && documentId > 0) {
    const initialChunks = await fetchNextDocumentChunks(documentId, 0, remainingChunks);
    for (const chunk of initialChunks) {
      if (!appendChunk(chunk, 0) || remainingCharacters <= 0 || remainingChunks <= 0) {
        break;
      }
      if (currentChunkOffset < currentChunkLength) {
        break;
      }
    }
  } else if (
    documentId > 0 &&
    currentChunkId > 0 &&
    currentChunkOffset >= currentChunkLength &&
    remainingCharacters > 0 &&
    remainingChunks > 0
  ) {
    const nextChunks = await fetchNextDocumentChunks(documentId, currentChunkId, remainingChunks);
    for (const chunk of nextChunks) {
      if (!appendChunk(chunk, 0) || remainingCharacters <= 0 || remainingChunks <= 0) {
        break;
      }
      if (currentChunkOffset < currentChunkLength) {
        break;
      }
    }
  }

  if (pieces.length === 0) {
    return {
      renderSource: null,
      nextSource: {
        ...source,
        continuationHasMore: false,
      },
      charactersUsed: 0,
      chunksUsed: 0,
      hasMoreInSource: false,
    };
  }

  let hasMoreInSource = currentChunkOffset < currentChunkLength;
  if (!hasMoreInSource && documentId > 0) {
    const nextChunk = await fetchNextDocumentChunks(documentId, currentChunkId, 1);
    hasMoreInSource = nextChunk.length > 0;
  }

  return {
    renderSource: {
      ...(activeRecord || {}),
      source: source.source || activeRecord?.source || "documents",
      id: source.id || activeRecord?.id || null,
      documentId: documentId || activeRecord?.documentId || activeRecord?.document_id || null,
      reference: activeRecord?.reference || activeRecord?.title || source.reference || source.title || "",
      title: activeRecord?.title || source.title || "",
      lawNumber: activeRecord?.lawNumber || source.lawNumber || "",
      url: activeRecord?.url || source.url || "",
      keyword: activeRecord?.keyword || source.keyword || "",
      content: normalizeContinuationText(pieces.join(" ")),
      comment: "",
      score: Number(options.score || 0),
    },
    nextSource: {
      ...source,
      documentId: documentId > 0 ? documentId : source.documentId || null,
      continuationMode: "document_chunks",
      continuationChunkId: currentChunkId || null,
      continuationChunkOffset: currentChunkOffset,
      continuationTotalLength: currentChunkLength,
      continuationHasMore: hasMoreInSource,
    },
    charactersUsed,
    chunksUsed,
    hasMoreInSource,
  };
}

async function paginateContinuationState(state = {}, options = {}) {
  const maxCharacters = Math.max(
    1,
    Number(options.maxCharacters || MAIN_CHAT_CONTINUATION_MAX_CHARACTERS),
  );
  const maxSourceChunks = Math.max(
    1,
    Number(options.maxSourceChunks || MAIN_CHAT_CONTINUATION_MAX_SOURCE_CHUNKS),
  );
  const sources = (Array.isArray(state.sources) ? state.sources : [])
    .slice(0, MAIN_CHAT_CONTINUATION_SOURCE_LIMIT)
    .map((source) => buildContinuationSourceState(source));
  const nextState = {
    ...state,
    activeSourceIndex: Math.max(0, Number(state.activeSourceIndex || 0)),
    sources,
  };
  const renderSources = [];
  let activeSourceIndex = nextState.activeSourceIndex;
  let remainingCharacters = maxCharacters;
  let remainingChunks = maxSourceChunks;

  while (
    activeSourceIndex < sources.length &&
    remainingCharacters > 0 &&
    remainingChunks > 0
  ) {
    const source = sources[activeSourceIndex];
    const syntheticScore = Math.max(1, 1000 - activeSourceIndex * 10);
    const sliceResult =
      source.continuationMode === "document_chunks" ||
      source.source === "documents" ||
      source.source === "pdf_chunks"
        ? await sliceDocumentSource(source, {
            remainingCharacters,
            remainingChunks,
            score: syntheticScore,
          })
        : await sliceTextSource(source, {
            remainingCharacters,
            score: syntheticScore,
          });

    if (!sliceResult) {
      break;
    }

    sources[activeSourceIndex] = buildContinuationSourceState(sliceResult.nextSource);
    if (sliceResult.renderSource) {
      renderSources.push(sliceResult.renderSource);
      remainingCharacters = Math.max(0, remainingCharacters - sliceResult.charactersUsed);
      remainingChunks = Math.max(0, remainingChunks - sliceResult.chunksUsed);
    }

    if (sliceResult.hasMoreInSource) {
      break;
    }

    activeSourceIndex += 1;
  }

  nextState.sources = sources;
  nextState.activeSourceIndex = activeSourceIndex;

  const hasMore =
    activeSourceIndex < sources.length &&
    sources.some((source, index) => {
      if (index < activeSourceIndex) {
        return false;
      }

      if (index > activeSourceIndex) {
        return true;
      }

      return source.continuationHasMore === true;
    });

  if (!hasMore) {
    nextState.activeSourceIndex = sources.length;
  }

  return {
    renderSources,
    nextState,
    hasMore,
  };
}

module.exports = {
  MAIN_CHAT_CONTINUATION_MAX_CHARACTERS,
  MAIN_CHAT_CONTINUATION_MAX_SOURCE_CHUNKS,
  MAIN_CHAT_CONTINUATION_SESSION_KEY,
  MAIN_CHAT_CONTINUATION_SOURCE_LIMIT,
  buildContinuationSourceState,
  createContinuationSessionState,
  getSessionContinuationState,
  paginateContinuationState,
  resolveContinuationState,
  setSessionContinuationState,
  signContinuationToken,
  verifyContinuationToken,
};
