/**
 * Script to generate embeddings for all pdf_chunks
 * Run with: node scripts/generateEmbeddings.js
 */

require("dotenv").config();
const { connectDb, getDbPool } = require("../config/db");
const { createEmbedding, embeddingToBuffer } = require("../services/embeddingService");

const BATCH_SIZE = 50;
const DELAY_MS = 100; // Delay between API calls to avoid rate limiting

async function generateEmbeddings() {
  console.log("=== Embedding Generation Script ===\n");
  
  await connectDb();
  const pool = getDbPool();

  // Get chunks without embeddings
  const [chunks] = await pool.query(`
    SELECT id, keyword, chunk_text 
    FROM pdf_chunks 
    WHERE embedding IS NULL
    ORDER BY id
  `);

  console.log(`Found ${chunks.length} chunks without embeddings\n`);

  if (chunks.length === 0) {
    console.log("All chunks already have embeddings!");
    process.exit(0);
  }

  let successCount = 0;
  let errorCount = 0;
  const startTime = Date.now();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const text = `${chunk.keyword || ""} ${chunk.chunk_text || ""}`.trim();

    try {
      const embedding = await createEmbedding(text);
      
      if (embedding) {
        const buffer = embeddingToBuffer(embedding);
        await pool.query(
          "UPDATE pdf_chunks SET embedding = ? WHERE id = ?",
          [buffer, chunk.id]
        );
        successCount++;
      } else {
        console.warn(`[${chunk.id}] Failed to create embedding`);
        errorCount++;
      }
    } catch (err) {
      console.error(`[${chunk.id}] Error:`, err.message);
      errorCount++;
    }

    // Progress logging
    if ((i + 1) % BATCH_SIZE === 0 || i === chunks.length - 1) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const remaining = chunks.length - i - 1;
      const rate = (i + 1) / parseFloat(elapsed);
      const eta = remaining > 0 ? (remaining / rate).toFixed(0) : 0;
      
      console.log(
        `Progress: ${i + 1}/${chunks.length} | ` +
        `Success: ${successCount} | Errors: ${errorCount} | ` +
        `Elapsed: ${elapsed}s | ETA: ${eta}s`
      );
    }

    // Rate limiting delay
    if (DELAY_MS > 0 && i < chunks.length - 1) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== Complete ===`);
  console.log(`Total: ${chunks.length} | Success: ${successCount} | Errors: ${errorCount}`);
  console.log(`Time: ${totalTime}s`);

  process.exit(0);
}

generateEmbeddings().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
