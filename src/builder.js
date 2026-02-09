'use strict';

const fs = require('fs');
const path = require('path');
const { openDb, initSchema } = require('./db');
const { createParsers, getParser, extractSymbols, extractHCLSymbols } = require('./parser');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.codegraph', '__pycache__', '.tox', 'vendor']);
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.tf', '.hcl']);

function collectFiles(dir, files = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return files; }

  // Check for .gitignore patterns (simple: just skip dirs in IGNORE_DIRS)
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORE_DIRS.has(entry.name)) continue;
      // skip hidden dirs except we already handle .git
      if (entry.isDirectory()) continue;
    }
    if (IGNORE_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, files);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Load tsconfig.json path aliases from a project root.
 * Returns { baseUrl, paths } where paths maps alias patterns to directory arrays.
 */
function loadPathAliases(rootDir) {
  const aliases = { baseUrl: null, paths: {} };
  for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = path.join(rootDir, configName);
    if (!fs.existsSync(configPath)) continue;
    try {
      // Strip comments (// and /* */) for JSON parsing
      const raw = fs.readFileSync(configPath, 'utf-8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([\]}])/g, '$1'); // trailing commas
      const config = JSON.parse(raw);
      const opts = config.compilerOptions || {};
      if (opts.baseUrl) aliases.baseUrl = path.resolve(rootDir, opts.baseUrl);
      if (opts.paths) {
        for (const [pattern, targets] of Object.entries(opts.paths)) {
          // pattern like "@/*" -> targets like ["./src/*"]
          aliases.paths[pattern] = targets.map(t => path.resolve(aliases.baseUrl || rootDir, t));
        }
      }
      break; // use first config found
    } catch { /* ignore parse errors */ }
  }
  return aliases;
}

/**
 * Try to resolve an import via path aliases.
 * Returns resolved absolute path or null.
 */
function resolveViaAlias(importSource, aliases, rootDir) {
  // Try baseUrl first (bare imports relative to baseUrl)
  if (aliases.baseUrl && !importSource.startsWith('.') && !importSource.startsWith('/')) {
    const candidate = path.resolve(aliases.baseUrl, importSource);
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      const full = candidate + ext;
      if (fs.existsSync(full)) return full;
    }
  }

  // Try path aliases
  for (const [pattern, targets] of Object.entries(aliases.paths)) {
    const prefix = pattern.replace(/\*$/, '');
    if (!importSource.startsWith(prefix)) continue;
    const rest = importSource.slice(prefix.length);
    for (const target of targets) {
      const resolved = target.replace(/\*$/, rest);
      for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
        const full = resolved + ext;
        if (fs.existsSync(full)) return full;
      }
    }
  }
  return null;
}

function resolveImportPath(fromFile, importSource, rootDir, aliases) {
  // Try path aliases first for non-relative imports
  if (!importSource.startsWith('.') && aliases) {
    const aliasResolved = resolveViaAlias(importSource, aliases, rootDir);
    if (aliasResolved) return path.relative(rootDir, aliasResolved);
  }
  if (!importSource.startsWith('.')) return importSource; // external package
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, importSource);
  
  // If import ends with .js, try .ts first (TypeScript ESM convention)
  if (resolved.endsWith('.js')) {
    const tsCandidate = resolved.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsCandidate)) return path.relative(rootDir, tsCandidate);
    const tsxCandidate = resolved.replace(/\.js$/, '.tsx');
    if (fs.existsSync(tsxCandidate)) return path.relative(rootDir, tsxCandidate);
  }
  
  // Try extensions
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js']) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      return path.relative(rootDir, candidate);
    }
  }
  // Maybe it already has extension
  if (fs.existsSync(resolved)) return path.relative(rootDir, resolved);
  return path.relative(rootDir, resolved);
}

function buildGraph(rootDir) {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);

  // Clear existing data
  db.exec('DELETE FROM edges; DELETE FROM nodes;');

  const parsers = createParsers();
  const aliases = loadPathAliases(rootDir);
  if (aliases.baseUrl || Object.keys(aliases.paths).length > 0) {
    console.log(`Loaded path aliases: baseUrl=${aliases.baseUrl || 'none'}, ${Object.keys(aliases.paths).length} path mappings`);
  }
  const files = collectFiles(rootDir);
  console.log(`Found ${files.length} files to parse`);

  const insertNode = db.prepare('INSERT OR IGNORE INTO nodes (name, kind, file, line) VALUES (?, ?, ?, ?)');
  const getNodeId = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?');
  const insertEdge = db.prepare('INSERT INTO edges (source_id, target_id, kind) VALUES (?, ?, ?)');

  // First pass: parse all files and insert nodes
  const fileSymbols = new Map();
  let parsed = 0, skipped = 0;

  const insertMany = db.transaction(() => {
    for (const filePath of files) {
      const parser = getParser(parsers, filePath);
      if (!parser) { skipped++; continue; }

      let code;
      try { code = fs.readFileSync(filePath, 'utf-8'); }
      catch { skipped++; continue; }

      let tree;
      try { tree = parser.parse(code); }
      catch (e) {
        console.warn(`  ⚠ Skipping ${path.relative(rootDir, filePath)}: ${e.message}`);
        skipped++;
        continue;
      }

      const relPath = path.relative(rootDir, filePath);
      const isHCL = filePath.endsWith('.tf') || filePath.endsWith('.hcl');
      const symbols = isHCL ? extractHCLSymbols(tree, filePath) : extractSymbols(tree, filePath);
      fileSymbols.set(relPath, symbols);

      // Insert file node
      insertNode.run(relPath, 'file', relPath, 0);

      // Insert definitions
      for (const def of symbols.definitions) {
        insertNode.run(def.name, def.kind, relPath, def.line);
      }

      // Insert exports
      for (const exp of symbols.exports) {
        insertNode.run(exp.name, exp.kind, relPath, exp.line);
      }

      parsed++;
      if (parsed % 100 === 0) process.stdout.write(`  Parsed ${parsed}/${files.length} files\r`);
    }
  });
  insertMany();
  console.log(`Parsed ${parsed} files (${skipped} skipped)`);

  // Second pass: build edges
  let edgeCount = 0;
  const buildEdges = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const fileNodeRow = getNodeId.get(relPath, 'file', relPath, 0);
      if (!fileNodeRow) continue;
      const fileNodeId = fileNodeRow.id;

      // Import edges: file -> imported file (skip type-only imports)
      for (const imp of symbols.imports) {
        const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
        // Find target file node
        const targetRow = getNodeId.get(resolvedPath, 'file', resolvedPath, 0);
        if (targetRow) {
          const edgeKind = imp.reexport ? 'reexports' : imp.typeOnly ? 'imports-type' : 'imports';
          insertEdge.run(fileNodeId, targetRow.id, edgeKind);
          edgeCount++;

          // Barrel export: if this file re-exports from target, anyone importing this file
          // implicitly depends on the target too. We mark these edges as 'reexports' for tracking.
        }
      }

      // Build import name -> target file mapping for precise call resolution
      const importedNames = new Map(); // name -> resolved file path
      for (const imp of symbols.imports) {
        const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
        for (const name of imp.names) {
          // Strip "* as X" style
          const cleanName = name.replace(/^\*\s+as\s+/, '');
          importedNames.set(cleanName, resolvedPath);
        }
      }

      // Call edges: definition in this file -> called function
      for (const call of symbols.calls) {
        // Find the calling function (the definition closest above the call line)
        let caller = null;
        for (const def of symbols.definitions) {
          if (def.line <= call.line) {
            const row = getNodeId.get(def.name, def.kind, relPath, def.line);
            if (row) caller = row;
          }
        }
        if (!caller) caller = fileNodeRow;

        // Precise resolution: if call name was imported, prefer target in that file
        let targets;
        const importedFrom = importedNames.get(call.name);
        if (importedFrom) {
          targets = db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (?, ?, ?) AND file = ?')
            .all(call.name, 'function', 'method', 'class', importedFrom);
        }
        if (!targets || targets.length === 0) {
          // Fallback: same-file definitions first, then global
          targets = db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (?, ?, ?) AND file = ?')
            .all(call.name, 'function', 'method', 'class', relPath);
          if (targets.length === 0) {
            // Try as method name (ClassName.methodName pattern stored as name)
            targets = db.prepare('SELECT id, file FROM nodes WHERE name LIKE ? AND kind = ?')
              .all(`%.${call.name}`, 'method');
            if (targets.length === 0) {
              targets = db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (?, ?, ?)')
                .all(call.name, 'function', 'method', 'class');
            }
          }
        }

        for (const t of targets) {
          if (t.id !== caller.id) {
            insertEdge.run(caller.id, t.id, 'calls');
            edgeCount++;
          }
        }
      }

      // Class extends edges
      for (const cls of symbols.classes) {
        const sourceRow = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ?').get(cls.name, 'class', relPath);
        const targetRows = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ?').all(cls.extends, 'class');
        if (sourceRow) {
          for (const t of targetRows) {
            insertEdge.run(sourceRow.id, t.id, 'extends');
            edgeCount++;
          }
        }
      }
    }
  });
  buildEdges();

  const nodeCount = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  console.log(`Graph built: ${nodeCount} nodes, ${edgeCount} edges`);
  console.log(`Stored in ${dbPath}`);
  db.close();
}

module.exports = { buildGraph };
