'use strict';

const Database = require('better-sqlite3');
const { findDbPath } = require('./db');

// Lazy-load transformers (heavy module)
let pipeline = null;
let cos_sim = null;
let extractor = null;

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;
const BATCH_SIZE = 32;

async function loadModel() {
  if (extractor) return extractor;
  const transformers = await import('@huggingface/transformers');
  pipeline = transformers.pipeline;
  cos_sim = transformers.cos_sim;
  
  console.log(`Loading embedding model: ${MODEL_NAME}...`);
  extractor = await pipeline('feature-extraction', MODEL_NAME, {
    quantized: true  // use quantized for speed
  });
  console.log('Model loaded.');
  return extractor;
}

/**
 * Generate embeddings for an array of texts.
 * Returns array of Float32Arrays.
 */
async function embed(texts) {
  const ext = await loadModel();
  const results = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const output = await ext(batch, { pooling: 'mean', normalize: true });
    
    // output.dims = [batchSize, EMBEDDING_DIM]
    for (let j = 0; j < batch.length; j++) {
      const start = j * EMBEDDING_DIM;
      const vec = new Float32Array(EMBEDDING_DIM);
      for (let k = 0; k < EMBEDDING_DIM; k++) {
        vec[k] = output.data[start + k];
      }
      results.push(vec);
    }
    
    if (texts.length > BATCH_SIZE) {
      process.stdout.write(`  Embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}\r`);
    }
  }
  
  return results;
}

/**
 * Cosine similarity between two Float32Arrays.
 */
function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Initialize embeddings table in the graph DB.
 */
function initEmbeddingsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embeddings (
      node_id INTEGER PRIMARY KEY,
      vector BLOB NOT NULL,
      text_preview TEXT,
      FOREIGN KEY(node_id) REFERENCES nodes(id)
    );
  `);
}

/**
 * Build embeddings for all functions/methods/classes in the graph.
 * Reads source files to get context around each definition.
 */
async function buildEmbeddings(rootDir) {
  const path = require('path');
  const fs = require('fs');
  const dbPath = findDbPath(null);
  
  // Open read-write
  const db = new Database(dbPath);
  initEmbeddingsSchema(db);
  
  // Clear existing embeddings
  db.exec('DELETE FROM embeddings');
  
  // Get all function/method/class nodes
  const nodes = db.prepare(
    `SELECT * FROM nodes WHERE kind IN ('function', 'method', 'class') ORDER BY file, line`
  ).all();
  
  console.log(`Building embeddings for ${nodes.length} symbols...`);
  
  // Group by file to read each file once
  const byFile = new Map();
  for (const node of nodes) {
    if (!byFile.has(node.file)) byFile.set(node.file, []);
    byFile.get(node.file).push(node);
  }
  
  // Build text representations
  const texts = [];
  const nodeIds = [];
  const previews = [];
  
  for (const [file, fileNodes] of byFile) {
    const fullPath = path.join(rootDir, file);
    let lines;
    try {
      lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
    } catch {
      continue;
    }
    
    for (const node of fileNodes) {
      // Extract context: function name + ~10 lines of code
      const startLine = Math.max(0, node.line - 1);
      const endLine = Math.min(lines.length, startLine + 15);
      const context = lines.slice(startLine, endLine).join('\n');
      
      // Build a searchable text: name + file path + code context
      const text = `${node.kind} ${node.name} in ${file}\n${context}`;
      texts.push(text);
      nodeIds.push(node.id);
      previews.push(`${node.name} (${node.kind}) — ${file}:${node.line}`);
    }
  }
  
  console.log(`Embedding ${texts.length} symbols...`);
  const vectors = await embed(texts);
  
  // Store in DB
  const insert = db.prepare('INSERT OR REPLACE INTO embeddings (node_id, vector, text_preview) VALUES (?, ?, ?)');
  const insertAll = db.transaction(() => {
    for (let i = 0; i < vectors.length; i++) {
      insert.run(nodeIds[i], Buffer.from(vectors[i].buffer), previews[i]);
    }
  });
  insertAll();
  
  console.log(`\nStored ${vectors.length} embeddings (${EMBEDDING_DIM}d) in graph.db`);
  db.close();
}

/**
 * Semantic search: find functions/methods/classes by natural language query.
 */
async function search(query, customDbPath, opts = {}) {
  const limit = opts.limit || 15;
  const noTests = opts.noTests || false;
  const minScore = opts.minScore || 0.2;
  
  const db = new Database(findDbPath(customDbPath), { readonly: true });
  
  // Check if embeddings exist
  const count = db.prepare("SELECT COUNT(*) as c FROM embeddings").get().c;
  if (count === 0) {
    console.log('No embeddings found. Run `codegraph embed` first.');
    db.close();
    return;
  }
  
  // Embed the query
  const [queryVec] = await embed([query]);
  
  // Load all embeddings and compute similarity
  const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;
  const rows = db.prepare(`
    SELECT e.node_id, e.vector, e.text_preview, n.name, n.kind, n.file, n.line
    FROM embeddings e
    JOIN nodes n ON e.node_id = n.id
  `).all();
  
  const results = [];
  for (const row of rows) {
    if (noTests && TEST_PATTERN.test(row.file)) continue;
    
    const vec = new Float32Array(new Uint8Array(row.vector).buffer);
    const sim = cosineSim(queryVec, vec);
    
    if (sim >= minScore) {
      results.push({
        name: row.name,
        kind: row.kind,
        file: row.file,
        line: row.line,
        similarity: sim
      });
    }
  }
  
  results.sort((a, b) => b.similarity - a.similarity);
  
  console.log(`\n🔍 Semantic search: "${query}"\n`);
  
  const topResults = results.slice(0, limit);
  if (topResults.length === 0) {
    console.log('  No results above threshold.');
  } else {
    for (const r of topResults) {
      const bar = '█'.repeat(Math.round(r.similarity * 20));
      const kindIcon = r.kind === 'function' ? 'ƒ' : r.kind === 'class' ? '◆' : '○';
      console.log(`  ${(r.similarity * 100).toFixed(1)}% ${bar}`);
      console.log(`    ${kindIcon} ${r.name} — ${r.file}:${r.line}`);
    }
  }
  
  console.log(`\n  ${results.length} results total (showing top ${topResults.length})\n`);
  db.close();
}

module.exports = { buildEmbeddings, search, embed, cosineSim, EMBEDDING_DIM };
