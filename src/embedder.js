'use strict';

const Database = require('better-sqlite3');
const { findDbPath } = require('./db');

// Lazy-load transformers (heavy module)
let pipeline = null;
let cos_sim = null;
let extractor = null;
let activeModel = null;

const MODELS = {
  'minilm': {
    name: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    desc: 'Smallest, fastest (~23MB). General text.',
    quantized: true
  },
  'jina-small': {
    name: 'Xenova/jina-embeddings-v2-small-en',
    dim: 512,
    desc: 'Small, good quality (~33MB). General text.',
    quantized: false
  },
  'jina-base': {
    name: 'Xenova/jina-embeddings-v2-base-en',
    dim: 768,
    desc: 'Larger, best quality (~137MB). General text, 8192 token context.',
    quantized: false
  }
};

const DEFAULT_MODEL = 'minilm';
const BATCH_SIZE = 32;

function getModelConfig(modelKey) {
  const key = modelKey || DEFAULT_MODEL;
  const config = MODELS[key];
  if (!config) {
    console.error(`Unknown model: ${key}. Available: ${Object.keys(MODELS).join(', ')}`);
    process.exit(1);
  }
  return config;
}

async function loadModel(modelKey) {
  const config = getModelConfig(modelKey);
  
  // If same model already loaded, reuse
  if (extractor && activeModel === config.name) return { extractor, config };
  
  const transformers = await import('@huggingface/transformers');
  pipeline = transformers.pipeline;
  cos_sim = transformers.cos_sim;
  
  console.log(`Loading embedding model: ${config.name} (${config.dim}d)...`);
  const opts = config.quantized ? { quantized: true } : {};
  extractor = await pipeline('feature-extraction', config.name, opts);
  activeModel = config.name;
  console.log('Model loaded.');
  return { extractor, config };
}

/**
 * Generate embeddings for an array of texts.
 * Returns { vectors: Float32Array[], dim: number }
 */
async function embed(texts, modelKey) {
  const { extractor: ext, config } = await loadModel(modelKey);
  const dim = config.dim;
  const results = [];
  
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const output = await ext(batch, { pooling: 'mean', normalize: true });
    
    for (let j = 0; j < batch.length; j++) {
      const start = j * dim;
      const vec = new Float32Array(dim);
      for (let k = 0; k < dim; k++) {
        vec[k] = output.data[start + k];
      }
      results.push(vec);
    }
    
    if (texts.length > BATCH_SIZE) {
      process.stdout.write(`  Embedded ${Math.min(i + BATCH_SIZE, texts.length)}/${texts.length}\r`);
    }
  }
  
  return { vectors: results, dim };
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
    CREATE TABLE IF NOT EXISTS embedding_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/**
 * Build embeddings for all functions/methods/classes in the graph.
 * Reads source files to get context around each definition.
 */
async function buildEmbeddings(rootDir, modelKey) {
  const path = require('path');
  const fs = require('fs');
  const dbPath = findDbPath(null);
  
  // Open read-write
  const db = new Database(dbPath);
  initEmbeddingsSchema(db);
  
  // Clear existing embeddings
  db.exec('DELETE FROM embeddings');
  db.exec('DELETE FROM embedding_meta');
  
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
  const { vectors, dim } = await embed(texts, modelKey);
  
  // Store in DB
  const insert = db.prepare('INSERT OR REPLACE INTO embeddings (node_id, vector, text_preview) VALUES (?, ?, ?)');
  const insertMeta = db.prepare('INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)');
  const insertAll = db.transaction(() => {
    for (let i = 0; i < vectors.length; i++) {
      insert.run(nodeIds[i], Buffer.from(vectors[i].buffer), previews[i]);
    }
    const config = getModelConfig(modelKey);
    insertMeta.run('model', config.name);
    insertMeta.run('dim', String(dim));
    insertMeta.run('count', String(vectors.length));
    insertMeta.run('built_at', new Date().toISOString());
  });
  insertAll();
  
  console.log(`\nStored ${vectors.length} embeddings (${dim}d, ${getModelConfig(modelKey).name}) in graph.db`);
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
  
  // Read stored model info to use the same model for query
  let storedModel = null;
  let storedDim = null;
  try {
    const modelRow = db.prepare("SELECT value FROM embedding_meta WHERE key = 'model'").get();
    const dimRow = db.prepare("SELECT value FROM embedding_meta WHERE key = 'dim'").get();
    if (modelRow) storedModel = modelRow.value;
    if (dimRow) storedDim = parseInt(dimRow.value);
  } catch { /* old DB without meta table */ }
  
  // Find the model key that matches stored model
  let modelKey = opts.model || null;
  if (!modelKey && storedModel) {
    for (const [key, config] of Object.entries(MODELS)) {
      if (config.name === storedModel) { modelKey = key; break; }
    }
  }
  
  // Embed the query
  const { vectors: [queryVec], dim } = await embed([query], modelKey);
  
  if (storedDim && dim !== storedDim) {
    console.log(`⚠ Warning: query model dimension (${dim}) doesn't match stored embeddings (${storedDim}).`);
    console.log(`  Re-run \`codegraph embed\` with the same model, or use --model to match.`);
    db.close();
    return;
  }
  
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

module.exports = { buildEmbeddings, search, embed, cosineSim, MODELS, DEFAULT_MODEL };
