const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-large";
const EMBEDDING_DIMENSIONS = 3072;
const OPENAI_EMBEDDING_TIMEOUT_MS = Number(process.env.OPENAI_EMBEDDING_TIMEOUT_MS || 4000);
const { isAiEnabled } = require("./runtimeSettingsService");

function getOpenAiEmbeddingConfig() {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    console.warn("[EmbeddingService] OPENAI_API_KEY not set");
    return null;
  }

  return {
    apiKey,
    model:
      String(process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL).trim() ||
      DEFAULT_EMBEDDING_MODEL,
  };
}

/**
 * Create embedding for a single text
 * @param {string} text - Text to embed
 * @returns {Promise<Float32Array|null>} - Embedding vector or null on error
 */
async function createEmbedding(text) {
  if (!(await isAiEnabled())) {
    return null;
  }

  const config = getOpenAiEmbeddingConfig();
  if (!config) {
    return null;
  }

  const cleanText = String(text || "").trim().slice(0, 8000);
  if (!cleanText) {
    return null;
  }

  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this runtime");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), OPENAI_EMBEDDING_TIMEOUT_MS);

  try {
    const response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        input: cleanText,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`OpenAI embedding failed with status ${response.status}`);
    }

    const payload = await response.json();
    const values = payload?.data?.[0]?.embedding;

    if (!Array.isArray(values) || values.length === 0) {
      console.warn("[EmbeddingService] Invalid embedding response");
      return null;
    }

    return new Float32Array(values);
  } catch (err) {
    if (err?.name === "AbortError") {
      console.error(
        `[EmbeddingService] Embedding request timed out after ${OPENAI_EMBEDDING_TIMEOUT_MS}ms`,
      );
      return null;
    }

    console.error("[EmbeddingService] Error creating embedding:", err?.message || err);
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Create embeddings for multiple texts (batch)
 * @param {string[]} texts - Array of texts to embed
 * @param {number} delayMs - Delay between requests to avoid rate limiting
 * @returns {Promise<(Float32Array|null)[]>} - Array of embeddings
 */
async function createEmbeddingsBatch(texts, delayMs = 100) {
  const results = [];

  for (let i = 0; i < texts.length; i++) {
    const embedding = await createEmbedding(texts[i]);
    results.push(embedding);

    if ((i + 1) % 50 === 0) {
      console.log(`[EmbeddingService] Progress: ${i + 1}/${texts.length}`);
    }

    if (delayMs > 0 && i < texts.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

/**
 * Convert Float32Array to Buffer for storage
 * @param {Float32Array} embedding
 * @returns {Buffer}
 */
function embeddingToBuffer(embedding) {
  if (!embedding) return null;
  return Buffer.from(embedding.buffer);
}

/**
 * Convert Buffer back to Float32Array
 * @param {Buffer} buffer
 * @returns {Float32Array}
 */
function bufferToEmbedding(buffer) {
  if (!buffer) return null;
  const alignedBuffer = Buffer.from(buffer);
  const arrayBuffer = alignedBuffer.buffer.slice(
    alignedBuffer.byteOffset,
    alignedBuffer.byteOffset + alignedBuffer.length,
  );
  return new Float32Array(arrayBuffer);
}

/**
 * Calculate cosine similarity between two embeddings
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} - Similarity score between -1 and 1
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    return 0;
  }

  return dotProduct / denominator;
}

/**
 * Find top-K most similar embeddings
 * @param {Float32Array} queryEmbedding - Query embedding
 * @param {{id: number, embedding: Float32Array}[]} candidates - Candidate embeddings
 * @param {number} topK - Number of results to return
 * @returns {{id: number, similarity: number}[]} - Top-K results sorted by similarity
 */
function findTopKSimilar(queryEmbedding, candidates, topK = 10) {
  if (!queryEmbedding || !candidates || candidates.length === 0) {
    return [];
  }

  const scored = candidates
    .filter((c) => c.embedding)
    .map((c) => ({
      id: c.id,
      similarity: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK);
}

module.exports = {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS,
  createEmbedding,
  createEmbeddingsBatch,
  embeddingToBuffer,
  bufferToEmbedding,
  cosineSimilarity,
  findTopKSimilar,
};
