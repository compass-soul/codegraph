'use strict';

const fs = require('fs');
const path = require('path');
const { openDb, initSchema } = require('./db');
const { createParsers, getParser, extractSymbols, extractHCLSymbols, extractPythonSymbols } = require('./parser');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.codegraph', '__pycache__', '.tox', 'vendor', '.venv', 'venv', 'env', '.env']);
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.tf', '.hcl', '.py']);

function shouldIgnore(filePath) {
  const parts = filePath.split(path.sep);
  return parts.some(p => IGNORE_DIRS.has(p));
}

function isTrackedExt(filePath) {
  return EXTENSIONS.has(path.extname(filePath));
}

/**
 * Parse a single file and update the database incrementally.
 * Returns a summary object { file, nodesAdded, nodesRemoved, edgesAdded }.
 */
function updateFile(db, rootDir, filePath, parsers, stmts) {
  const relPath = path.relative(rootDir, filePath);

  // Count old nodes/edges for this file
  const oldNodes = stmts.countNodes.get(relPath)?.c || 0;
  const oldEdges = stmts.countEdgesForFile.get(relPath)?.c || 0;

  // Delete old data for this file
  stmts.deleteEdgesForFile.run(relPath);
  stmts.deleteNodes.run(relPath);

  // Check if file still exists
  if (!fs.existsSync(filePath)) {
    return { file: relPath, nodesAdded: 0, nodesRemoved: oldNodes, edgesAdded: 0, deleted: true };
  }

  const parser = getParser(parsers, filePath);
  if (!parser) return null;

  let code;
  try { code = fs.readFileSync(filePath, 'utf-8'); } catch { return null; }

  let tree;
  try { tree = parser.parse(code); } catch { return null; }

  const isHCL = filePath.endsWith('.tf') || filePath.endsWith('.hcl');
  const isPython = filePath.endsWith('.py');
  const symbols = isHCL ? extractHCLSymbols(tree, filePath)
    : isPython ? extractPythonSymbols(tree, filePath)
    : extractSymbols(tree, filePath);

  // Insert file node
  stmts.insertNode.run(relPath, 'file', relPath, 0, null);

  // Insert definition nodes
  for (const def of symbols.definitions) {
    stmts.insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
  }
  for (const exp of symbols.exports) {
    stmts.insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
  }

  const newNodes = stmts.countNodes.get(relPath)?.c || 0;

  // Build import edges
  let edgesAdded = 0;
  const fileNodeRow = stmts.getNodeId.get(relPath, 'file', relPath, 0);
  if (!fileNodeRow) return { file: relPath, nodesAdded: newNodes, nodesRemoved: oldNodes, edgesAdded: 0 };
  const fileNodeId = fileNodeRow.id;

  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportSimple(path.join(rootDir, relPath), imp.source, rootDir);
    const targetRow = stmts.getNodeId.get(resolvedPath, 'file', resolvedPath, 0);
    if (targetRow) {
      const edgeKind = imp.reexport ? 'reexports' : imp.typeOnly ? 'imports-type' : 'imports';
      stmts.insertEdge.run(fileNodeId, targetRow.id, edgeKind, 1.0, 0);
      edgesAdded++;
    }
  }

  // Build call edges
  const importedNames = new Map();
  for (const imp of symbols.imports) {
    const resolvedPath = resolveImportSimple(path.join(rootDir, relPath), imp.source, rootDir);
    for (const name of imp.names) {
      importedNames.set(name.replace(/^\*\s+as\s+/, ''), resolvedPath);
    }
  }

  for (const call of symbols.calls) {
    let caller = null;
    for (const def of symbols.definitions) {
      if (def.line <= call.line) {
        const row = stmts.getNodeId.get(def.name, def.kind, relPath, def.line);
        if (row) caller = row;
      }
    }
    if (!caller) caller = fileNodeRow;

    const importedFrom = importedNames.get(call.name);
    let targets;
    if (importedFrom) {
      targets = stmts.findNodeInFile.all(call.name, importedFrom);
    }
    if (!targets || targets.length === 0) {
      targets = stmts.findNodeInFile.all(call.name, relPath);
      if (targets.length === 0) {
        targets = stmts.findNodeByName.all(call.name);
      }
    }

    for (const t of targets) {
      if (t.id !== caller.id) {
        stmts.insertEdge.run(caller.id, t.id, 'calls', importedFrom ? 1.0 : 0.5, call.dynamic ? 1 : 0);
        edgesAdded++;
      }
    }
  }

  return {
    file: relPath,
    nodesAdded: newNodes,
    nodesRemoved: oldNodes,
    edgesAdded,
    deleted: false
  };
}

function resolveImportSimple(fromFile, importSource, rootDir) {
  if (!importSource.startsWith('.')) return importSource;
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, importSource);
  for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '/index.ts', '/index.tsx', '/index.js']) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) return path.relative(rootDir, candidate);
  }
  return path.relative(rootDir, resolved);
}

function watchProject(rootDir) {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  if (!fs.existsSync(dbPath)) {
    console.error('No graph.db found. Run `codegraph build` first.');
    process.exit(1);
  }

  const db = openDb(dbPath);
  initSchema(db);
  const parsers = createParsers();

  // Prepared statements
  const stmts = {
    insertNode: db.prepare('INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)'),
    getNodeId: db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?'),
    insertEdge: db.prepare('INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)'),
    deleteNodes: db.prepare('DELETE FROM nodes WHERE file = ?'),
    deleteEdgesForFile: db.prepare(`DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?) OR target_id IN (SELECT id FROM nodes WHERE file = ?)`),
    countNodes: db.prepare('SELECT COUNT(*) as c FROM nodes WHERE file = ?'),
    countEdgesForFile: db.prepare(`SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = ?) OR target_id IN (SELECT id FROM nodes WHERE file = ?)`),
    findNodeInFile: db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (\'function\', \'method\', \'class\', \'interface\') AND file = ?'),
    findNodeByName: db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (\'function\', \'method\', \'class\', \'interface\')'),
  };

  // Fix the deleteEdgesForFile and countEdgesForFile to use two params
  stmts.deleteEdgesForFile = db.prepare(`DELETE FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`);
  stmts.countEdgesForFile = db.prepare(`SELECT COUNT(*) as c FROM edges WHERE source_id IN (SELECT id FROM nodes WHERE file = @f) OR target_id IN (SELECT id FROM nodes WHERE file = @f)`);

  // Override to use named params
  const origDeleteEdges = stmts.deleteEdgesForFile;
  const origCountEdges = stmts.countEdgesForFile;
  stmts.deleteEdgesForFile = { run: (f) => origDeleteEdges.run({ f }) };
  stmts.countEdgesForFile = { get: (f) => origCountEdges.get({ f }) };

  // Debounce: collect changes and process after settling
  const pending = new Set();
  let timer = null;
  const DEBOUNCE_MS = 300;

  function processPending() {
    const files = [...pending];
    pending.clear();

    const updates = db.transaction(() => {
      const results = [];
      for (const filePath of files) {
        const result = updateFile(db, rootDir, filePath, parsers, stmts);
        if (result) results.push(result);
      }
      return results;
    })();

    for (const r of updates) {
      const nodeDelta = r.nodesAdded - r.nodesRemoved;
      const nodeStr = nodeDelta >= 0 ? `+${nodeDelta}` : `${nodeDelta}`;
      if (r.deleted) {
        console.log(`Removed: ${r.file} (-${r.nodesRemoved} nodes)`);
      } else {
        console.log(`Updated: ${r.file} (${nodeStr} nodes, +${r.edgesAdded} edges)`);
      }
    }
  }

  console.log(`Watching ${rootDir} for changes...`);
  console.log('Press Ctrl+C to stop.\n');

  const watcher = fs.watch(rootDir, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (shouldIgnore(filename)) return;
    if (!isTrackedExt(filename)) return;

    const fullPath = path.join(rootDir, filename);
    pending.add(fullPath);

    if (timer) clearTimeout(timer);
    timer = setTimeout(processPending, DEBOUNCE_MS);
  });

  process.on('SIGINT', () => {
    console.log('\nStopping watcher...');
    watcher.close();
    db.close();
    process.exit(0);
  });
}

module.exports = { watchProject };
