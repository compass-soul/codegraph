'use strict';

const fs = require('fs');
const path = require('path');
const { openDb, initSchema } = require('./db');
const { createParsers, getParser, extractSymbols, extractHCLSymbols, extractPythonSymbols } = require('./parser');

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.codegraph', '__pycache__', '.tox', 'vendor', '.venv', 'venv', 'env', '.env']);
const EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.tf', '.hcl', '.py']);

function collectFiles(dir, files = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return files; }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (IGNORE_DIRS.has(entry.name)) continue;
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

function loadPathAliases(rootDir) {
  const aliases = { baseUrl: null, paths: {} };
  for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    const configPath = path.join(rootDir, configName);
    if (!fs.existsSync(configPath)) continue;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8')
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/,\s*([\]}])/g, '$1');
      const config = JSON.parse(raw);
      const opts = config.compilerOptions || {};
      if (opts.baseUrl) aliases.baseUrl = path.resolve(rootDir, opts.baseUrl);
      if (opts.paths) {
        for (const [pattern, targets] of Object.entries(opts.paths)) {
          aliases.paths[pattern] = targets.map(t => path.resolve(aliases.baseUrl || rootDir, t));
        }
      }
      break;
    } catch { /* ignore parse errors */ }
  }
  return aliases;
}

function resolveViaAlias(importSource, aliases, rootDir) {
  if (aliases.baseUrl && !importSource.startsWith('.') && !importSource.startsWith('/')) {
    const candidate = path.resolve(aliases.baseUrl, importSource);
    for (const ext of ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js']) {
      const full = candidate + ext;
      if (fs.existsSync(full)) return full;
    }
  }

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
  if (!importSource.startsWith('.') && aliases) {
    const aliasResolved = resolveViaAlias(importSource, aliases, rootDir);
    if (aliasResolved) return path.relative(rootDir, aliasResolved);
  }
  if (!importSource.startsWith('.')) return importSource;
  const dir = path.dirname(fromFile);
  let resolved = path.resolve(dir, importSource);
  
  if (resolved.endsWith('.js')) {
    const tsCandidate = resolved.replace(/\.js$/, '.ts');
    if (fs.existsSync(tsCandidate)) return path.relative(rootDir, tsCandidate);
    const tsxCandidate = resolved.replace(/\.js$/, '.tsx');
    if (fs.existsSync(tsxCandidate)) return path.relative(rootDir, tsxCandidate);
  }
  
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '/index.ts', '/index.tsx', '/index.js', '/__init__.py']) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      return path.relative(rootDir, candidate);
    }
  }
  if (fs.existsSync(resolved)) return path.relative(rootDir, resolved);
  return path.relative(rootDir, resolved);
}

/**
 * Compute proximity-based confidence for call resolution.
 * Improvement #3: rank by import distance.
 */
function computeConfidence(callerFile, targetFile, importedFrom) {
  if (!targetFile || !callerFile) return 0.3;
  // Same file
  if (callerFile === targetFile) return 1.0;
  // Directly imported
  if (importedFrom === targetFile) return 1.0;
  // Same directory
  if (path.dirname(callerFile) === path.dirname(targetFile)) return 0.7;
  // Same parent directory
  const callerParent = path.dirname(path.dirname(callerFile));
  const targetParent = path.dirname(path.dirname(targetFile));
  if (callerParent === targetParent) return 0.5;
  // Distant
  return 0.3;
}

function buildGraph(rootDir) {
  const dbPath = path.join(rootDir, '.codegraph', 'graph.db');
  const db = openDb(dbPath);
  initSchema(db);

  db.exec('PRAGMA foreign_keys = OFF; DELETE FROM edges; DELETE FROM nodes; PRAGMA foreign_keys = ON;');

  const parsers = createParsers();
  const aliases = loadPathAliases(rootDir);
  if (aliases.baseUrl || Object.keys(aliases.paths).length > 0) {
    console.log(`Loaded path aliases: baseUrl=${aliases.baseUrl || 'none'}, ${Object.keys(aliases.paths).length} path mappings`);
  }
  const files = collectFiles(rootDir);
  console.log(`Found ${files.length} files to parse`);

  const insertNode = db.prepare('INSERT OR IGNORE INTO nodes (name, kind, file, line, end_line) VALUES (?, ?, ?, ?, ?)');
  const getNodeId = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?');
  const insertEdge = db.prepare('INSERT INTO edges (source_id, target_id, kind, confidence, dynamic) VALUES (?, ?, ?, ?, ?)');

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
      const isPython = filePath.endsWith('.py');
      const symbols = isHCL ? extractHCLSymbols(tree, filePath)
        : isPython ? extractPythonSymbols(tree, filePath)
        : extractSymbols(tree, filePath);
      fileSymbols.set(relPath, symbols);

      insertNode.run(relPath, 'file', relPath, 0, null);

      for (const def of symbols.definitions) {
        insertNode.run(def.name, def.kind, relPath, def.line, def.endLine || null);
      }

      for (const exp of symbols.exports) {
        insertNode.run(exp.name, exp.kind, relPath, exp.line, null);
      }

      parsed++;
      if (parsed % 100 === 0) process.stdout.write(`  Parsed ${parsed}/${files.length} files\r`);
    }
  });
  insertMany();
  console.log(`Parsed ${parsed} files (${skipped} skipped)`);

  // Build re-export map for barrel resolution
  // Maps: file -> [{ source: resolvedPath, names: [...], wildcardReexport: bool }]
  const reexportMap = new Map();
  for (const [relPath, symbols] of fileSymbols) {
    const reexports = symbols.imports.filter(imp => imp.reexport);
    if (reexports.length > 0) {
      reexportMap.set(relPath, reexports.map(imp => ({
        source: resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases),
        names: imp.names,
        wildcardReexport: imp.wildcardReexport || false
      })));
    }
  }

  /**
   * Determine if a file is a barrel (mainly re-exports with few/no own definitions).
   */
  function isBarrelFile(relPath) {
    const symbols = fileSymbols.get(relPath);
    if (!symbols) return false;
    const reexports = symbols.imports.filter(imp => imp.reexport);
    if (reexports.length === 0) return false;
    // A barrel has more re-exports than own definitions (excluding re-exported names)
    const ownDefs = symbols.definitions.length;
    return reexports.length >= ownDefs;
  }

  /**
   * Resolve a symbol name through barrel re-exports.
   * Returns the actual file path where the symbol is defined, or null.
   * visited prevents infinite loops.
   */
  function resolveBarrelExport(barrelPath, symbolName, visited = new Set()) {
    if (visited.has(barrelPath)) return null;
    visited.add(barrelPath);

    const reexports = reexportMap.get(barrelPath);
    if (!reexports) return null;

    for (const re of reexports) {
      // Named re-export: export { foo } from './bar' — check if symbolName is in names
      if (re.names.length > 0 && !re.wildcardReexport) {
        if (re.names.includes(symbolName)) {
          // Check if the target file actually defines it
          const targetSymbols = fileSymbols.get(re.source);
          if (targetSymbols) {
            const hasDef = targetSymbols.definitions.some(d => d.name === symbolName);
            if (hasDef) return re.source;
            // Maybe it's another barrel
            const deeper = resolveBarrelExport(re.source, symbolName, visited);
            if (deeper) return deeper;
          }
          return re.source; // best guess
        }
        continue;
      }

      // Wildcard re-export: export * from './bar' or module.exports = require('./bar')
      if (re.wildcardReexport || re.names.length === 0) {
        const targetSymbols = fileSymbols.get(re.source);
        if (targetSymbols) {
          const hasDef = targetSymbols.definitions.some(d => d.name === symbolName);
          if (hasDef) return re.source;
          // Follow further barrels
          const deeper = resolveBarrelExport(re.source, symbolName, visited);
          if (deeper) return deeper;
        }
      }
    }

    return null;
  }

  // Second pass: build edges
  let edgeCount = 0;
  const buildEdges = db.transaction(() => {
    for (const [relPath, symbols] of fileSymbols) {
      const fileNodeRow = getNodeId.get(relPath, 'file', relPath, 0);
      if (!fileNodeRow) continue;
      const fileNodeId = fileNodeRow.id;

      // Import edges
      for (const imp of symbols.imports) {
        const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
        const targetRow = getNodeId.get(resolvedPath, 'file', resolvedPath, 0);
        if (targetRow) {
          const edgeKind = imp.reexport ? 'reexports' : imp.typeOnly ? 'imports-type' : 'imports';
          insertEdge.run(fileNodeId, targetRow.id, edgeKind, 1.0, 0);
          edgeCount++;

          // Barrel resolution: if importing from a barrel, also add edges to actual sources
          if (!imp.reexport && isBarrelFile(resolvedPath)) {
            const resolvedSources = new Set();
            for (const name of imp.names) {
              const cleanName = name.replace(/^\*\s+as\s+/, '');
              const actualSource = resolveBarrelExport(resolvedPath, cleanName);
              if (actualSource && actualSource !== resolvedPath && !resolvedSources.has(actualSource)) {
                resolvedSources.add(actualSource);
                const actualRow = getNodeId.get(actualSource, 'file', actualSource, 0);
                if (actualRow) {
                  insertEdge.run(fileNodeId, actualRow.id, edgeKind === 'imports-type' ? 'imports-type' : 'imports', 0.9, 0);
                  edgeCount++;
                }
              }
            }
          }
        }
      }

      // Build import name -> target file mapping
      const importedNames = new Map();
      for (const imp of symbols.imports) {
        const resolvedPath = resolveImportPath(path.join(rootDir, relPath), imp.source, rootDir, aliases);
        for (const name of imp.names) {
          const cleanName = name.replace(/^\*\s+as\s+/, '');
          importedNames.set(cleanName, resolvedPath);
        }
      }

      // Call edges with confidence scoring
      for (const call of symbols.calls) {
        let caller = null;
        for (const def of symbols.definitions) {
          if (def.line <= call.line) {
            const row = getNodeId.get(def.name, def.kind, relPath, def.line);
            if (row) caller = row;
          }
        }
        if (!caller) caller = fileNodeRow;

        const isDynamic = call.dynamic ? 1 : 0;
        let targets;
        const importedFrom = importedNames.get(call.name);

        if (importedFrom) {
          targets = db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (?, ?, ?, ?) AND file = ?')
            .all(call.name, 'function', 'method', 'class', 'interface', importedFrom);

          // Barrel resolution: if no targets in the barrel file, resolve through re-exports
          if (targets.length === 0 && isBarrelFile(importedFrom)) {
            const actualSource = resolveBarrelExport(importedFrom, call.name);
            if (actualSource) {
              targets = db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (?, ?, ?, ?) AND file = ?')
                .all(call.name, 'function', 'method', 'class', 'interface', actualSource);
            }
          }
        }
        if (!targets || targets.length === 0) {
          targets = db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (?, ?, ?, ?) AND file = ?')
            .all(call.name, 'function', 'method', 'class', 'interface', relPath);
          if (targets.length === 0) {
            targets = db.prepare('SELECT id, file FROM nodes WHERE name LIKE ? AND kind = ?')
              .all(`%.${call.name}`, 'method');
            if (targets.length === 0) {
              targets = db.prepare('SELECT id, file FROM nodes WHERE name = ? AND kind IN (?, ?, ?, ?)')
                .all(call.name, 'function', 'method', 'class', 'interface');
            }
          }
        }

        // Improvement #3: rank by confidence, pick best matches
        if (targets.length > 1) {
          targets.sort((a, b) => {
            const confA = computeConfidence(relPath, a.file, importedFrom);
            const confB = computeConfidence(relPath, b.file, importedFrom);
            return confB - confA;
          });
        }

        for (const t of targets) {
          if (t.id !== caller.id) {
            const confidence = computeConfidence(relPath, t.file, importedFrom);
            insertEdge.run(caller.id, t.id, 'calls', confidence, isDynamic);
            edgeCount++;
          }
        }
      }

      // Class extends edges
      for (const cls of symbols.classes) {
        if (cls.extends) {
          const sourceRow = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ?').get(cls.name, 'class', relPath);
          const targetRows = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ?').all(cls.extends, 'class');
          if (sourceRow) {
            for (const t of targetRows) {
              insertEdge.run(sourceRow.id, t.id, 'extends', 1.0, 0);
              edgeCount++;
            }
          }
        }

        // Improvement #4: implements edges
        if (cls.implements) {
          const sourceRow = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ?').get(cls.name, 'class', relPath);
          const targetRows = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind IN (?, ?)').all(cls.implements, 'interface', 'class');
          if (sourceRow) {
            for (const t of targetRows) {
              insertEdge.run(sourceRow.id, t.id, 'implements', 1.0, 0);
              edgeCount++;
            }
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
