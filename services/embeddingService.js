const { GoogleGenAI } = require("@google/genai");

const EMBEDDING_MODEL = "gemini-embedding-001";
const EMBEDDING_DIMENSIONS = 3072;

let geminiClient = null;

function getGeminiClient() {
  if (!geminiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("[EmbeddingService] GEMINI_API_KEY not set");
      return null;
    }
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

/**
 * Create embedding for a single text
 * @param {string} text - Text to embed
 * @returns {Promise<Float32Array|null>} - Embedding vector or null on error
 */
async function createEmbedding(text) {
  const client = getGeminiClient();
  if (!client) {
    return null;
  }

  const cleanText = String(text || "").trim().slice(0, 8000); // Gemini limit
  if (!cleanText) {
    return null;
  }

  try {
    const response = await client.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: cleanText,
    });

    const values = response?.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      console.warn("[EmbeddingService] Invalid embedding response");
      return null;
    }

    return new Float32Array(values);
  } catch (err) {
    console.error("[EmbeddingService] Error creating embedding:", err?.message || err);
    return null;
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
    
    // Progress logging
    if ((i + 1) % 50 === 0) {
      console.log(`[EmbeddingService] Progress: ${i + 1}/${texts.length}`);
    }
    
    // Rate limiting delay
    if (delayMs > 0 && i < texts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
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
  // Copy buffer to ensure proper alignment for Float32Array
  const alignedBuffer = Buffer.from(buffer);
  const arrayBuffer = alignedBuffer.buffer.slice(
    alignedBuffer.byteOffset,
    alignedBuffer.byteOffset + alignedBuffer.length
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
    .filter(c => c.embedding)
    .map(c => ({
      id: c.id,
      similarity: cosineSimilarity(queryEmbedding, c.embedding),
    }))
    .sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK);
}

module.exports = {
  EMBEDDING_DIMENSIONS,
  createEmbedding,
  createEmbeddingsBatch,
  embeddingToBuffer,
  bufferToEmbedding,
  cosineSimilarity,
  findTopKSimilar,
};
