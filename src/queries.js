'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const { execSync } = require('child_process');
const { findDbPath } = require('./db');

function openReadonly(customPath) {
  const dbPath = findDbPath(customPath);
  return new Database(dbPath, { readonly: true });
}

const TEST_PATTERN = /\.(test|spec)\.|__test__|__tests__|\.stories\./;
function isTestFile(filePath) {
  return TEST_PATTERN.test(filePath);
}

/**
 * Get all ancestor class names for a given class using extends edges.
 * Returns Set of class node ids that are in the inheritance chain.
 */
function getClassHierarchy(db, classNodeId) {
  const ancestors = new Set();
  const queue = [classNodeId];
  while (queue.length > 0) {
    const current = queue.shift();
    const parents = db.prepare(`
      SELECT n.id, n.name FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ? AND e.kind = 'extends'
    `).all(current);
    for (const p of parents) {
      if (!ancestors.has(p.id)) {
        ancestors.add(p.id);
        queue.push(p.id);
      }
    }
  }
  return ancestors;
}

/**
 * For a method call like "foo", find methods named "foo" that could be reached
 * through class hierarchy (i.e., the method is defined on a parent class).
 */
function resolveMethodViaHierarchy(db, methodName) {
  // Find all methods with this name
  const methods = db.prepare(
    `SELECT * FROM nodes WHERE kind = 'method' AND name LIKE ?`
  ).all(`%.${methodName}`);

  // For each, also find methods on parent classes
  const results = [...methods];
  for (const m of methods) {
    const className = m.name.split('.')[0];
    const classNode = db.prepare(
      `SELECT * FROM nodes WHERE name = ? AND kind = 'class' AND file = ?`
    ).get(className, m.file);
    if (!classNode) continue;

    const ancestors = getClassHierarchy(db, classNode.id);
    for (const ancestorId of ancestors) {
      const ancestor = db.prepare('SELECT name FROM nodes WHERE id = ?').get(ancestorId);
      if (!ancestor) continue;
      const parentMethods = db.prepare(
        `SELECT * FROM nodes WHERE name = ? AND kind = 'method'`
      ).all(`${ancestor.name}.${methodName}`);
      results.push(...parentMethods);
    }
  }
  return results;
}

function queryName(name, customDbPath) {
  const db = openReadonly(customDbPath);

  const nodes = db.prepare(`SELECT * FROM nodes WHERE name LIKE ?`).all(`%${name}%`);
  if (nodes.length === 0) {
    console.log(`No results for "${name}"`);
    db.close();
    return;
  }

  console.log(`\n🔍 Results for "${name}":\n`);

  for (const node of nodes) {
    console.log(`  ${kindIcon(node.kind)} ${node.name} (${node.kind}) — ${node.file}:${node.line}`);

    // Callees (what this node calls)
    const callees = db.prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ?
    `).all(node.id);

    if (callees.length > 0) {
      console.log(`    → calls/uses:`);
      for (const c of callees.slice(0, 15)) {
        console.log(`      → ${c.name} (${c.edge_kind}) ${c.file}:${c.line}`);
      }
      if (callees.length > 15) console.log(`      ... and ${callees.length - 15} more`);
    }

    // Callers (what calls this node)
    const callers = db.prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ?
    `).all(node.id);

    if (callers.length > 0) {
      console.log(`    ← called by:`);
      for (const c of callers.slice(0, 15)) {
        console.log(`      ← ${c.name} (${c.edge_kind}) ${c.file}:${c.line}`);
      }
      if (callers.length > 15) console.log(`      ... and ${callers.length - 15} more`);
    }
    console.log();
  }

  db.close();
}

function impactAnalysis(file, customDbPath) {
  const db = openReadonly(customDbPath);

  // Find the file node
  const fileNodes = db.prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`).all(`%${file}%`);
  if (fileNodes.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    db.close();
    return;
  }

  console.log(`\n💥 Impact analysis for files matching "${file}":\n`);

  // BFS reverse through import edges
  const visited = new Set();
  const queue = [];
  const levels = new Map();

  for (const fn of fileNodes) {
    visited.add(fn.id);
    queue.push(fn.id);
    levels.set(fn.id, 0);
    console.log(`  📄 ${fn.file} (source)`);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const level = levels.get(current);

    // Find files that import this file (runtime imports only, not type-only)
    const dependents = db.prepare(`
      SELECT n.* FROM edges e
      JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')
    `).all(current);

    for (const dep of dependents) {
      if (!visited.has(dep.id)) {
        visited.add(dep.id);
        queue.push(dep.id);
        levels.set(dep.id, level + 1);
      }
    }
  }

  // Group by level
  const byLevel = new Map();
  for (const [id, level] of levels) {
    if (level === 0) continue;
    if (!byLevel.has(level)) byLevel.set(level, []);
    const node = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    if (node) byLevel.get(level).push(node);
  }

  if (byLevel.size === 0) {
    console.log(`  No dependents found.`);
  } else {
    for (const [level, nodes] of [...byLevel].sort((a, b) => a[0] - b[0])) {
      console.log(`\n  ${'─'.repeat(level)} Level ${level} (${nodes.length} files):`);
      for (const n of nodes.slice(0, 30)) {
        console.log(`    ${'  '.repeat(level)}↑ ${n.file}`);
      }
      if (nodes.length > 30) console.log(`    ... and ${nodes.length - 30} more`);
    }
  }

  console.log(`\n  Total: ${visited.size - fileNodes.length} files transitively depend on "${file}"\n`);
  db.close();
}

function moduleMap(customDbPath, limit = 20) {
  const db = openReadonly(customDbPath);

  console.log(`\n🗺  Module map (top ${limit} most-connected nodes):\n`);

  // Rank by inbound edges (being depended on) — skip test files
  const nodes = db.prepare(`
    SELECT n.*, 
      (SELECT COUNT(*) FROM edges WHERE source_id = n.id) as out_edges,
      (SELECT COUNT(*) FROM edges WHERE target_id = n.id) as in_edges
    FROM nodes n
    WHERE n.kind = 'file'
      AND n.file NOT LIKE '%.test.%'
      AND n.file NOT LIKE '%.spec.%'
      AND n.file NOT LIKE '%__test__%'
    ORDER BY (SELECT COUNT(*) FROM edges WHERE target_id = n.id) DESC
    LIMIT ?
  `).all(limit);

  // Group by directory
  const dirs = new Map();
  for (const n of nodes) {
    const dir = path.dirname(n.file) || '.';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(n);
  }

  for (const [dir, files] of [...dirs].sort()) {
    console.log(`  📁 ${dir}/`);
    for (const f of files) {
      const total = f.in_edges + f.out_edges;
      const bar = '█'.repeat(Math.min(total, 40));
      console.log(`    ${path.basename(f.file).padEnd(35)} ←${String(f.in_edges).padStart(3)} →${String(f.out_edges).padStart(3)}  ${bar}`);
    }
  }

  // Overall stats
  const totalNodes = db.prepare('SELECT COUNT(*) as c FROM nodes').get().c;
  const totalEdges = db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
  const totalFiles = db.prepare("SELECT COUNT(*) as c FROM nodes WHERE kind = 'file'").get().c;
  console.log(`\n  📊 Total: ${totalFiles} files, ${totalNodes} symbols, ${totalEdges} edges\n`);

  db.close();
}

function fileDeps(file, customDbPath) {
  const db = openReadonly(customDbPath);

  const fileNodes = db.prepare(`SELECT * FROM nodes WHERE file LIKE ? AND kind = 'file'`).all(`%${file}%`);
  if (fileNodes.length === 0) {
    console.log(`No file matching "${file}" in graph`);
    db.close();
    return;
  }

  for (const fn of fileNodes) {
    console.log(`\n📄 ${fn.file}\n`);

    // What this file imports
    const importsTo = db.prepare(`
      SELECT n.file, e.kind as edge_kind FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ? AND e.kind IN ('imports', 'imports-type')
    `).all(fn.id);

    console.log(`  → Imports (${importsTo.length}):`);
    for (const i of importsTo) {
      const typeTag = i.edge_kind === 'imports-type' ? ' (type-only)' : '';
      console.log(`    → ${i.file}${typeTag}`);
    }

    // What imports this file
    const importedBy = db.prepare(`
      SELECT n.file, e.kind as edge_kind FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')
    `).all(fn.id);

    console.log(`\n  ← Imported by (${importedBy.length}):`);
    for (const i of importedBy) {
      console.log(`    ← ${i.file}`);
    }

    // Definitions in this file
    const defs = db.prepare(`SELECT * FROM nodes WHERE file = ? AND kind != 'file' ORDER BY line`).all(fn.file);
    if (defs.length > 0) {
      console.log(`\n  📋 Definitions (${defs.length}):`);
      for (const d of defs.slice(0, 30)) {
        console.log(`    ${kindIcon(d.kind)} ${d.name} :${d.line}`);
      }
      if (defs.length > 30) console.log(`    ... and ${defs.length - 30} more`);
    }
    console.log();
  }

  db.close();
}

function kindIcon(kind) {
  switch (kind) {
    case 'function': return 'ƒ';
    case 'class': return '◆';
    case 'method': return '○';
    case 'file': return '📄';
    default: return '•';
  }
}

/**
 * Function-level dependency view: show a function's callers, callees, and the call chain.
 */
function fnDeps(name, customDbPath, opts = {}) {
  const db = openReadonly(customDbPath);
  const depth = opts.depth || 3;
  const noTests = opts.noTests || false;

  // Find matching function/method/class nodes (not files)
  let nodes = db.prepare(
    `SELECT * FROM nodes WHERE name LIKE ? AND kind IN ('function', 'method', 'class') ORDER BY file, line`
  ).all(`%${name}%`);
  if (noTests) nodes = nodes.filter(n => !isTestFile(n.file));

  if (nodes.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    db.close();
    return;
  }

  for (const node of nodes) {
    console.log(`\n${kindIcon(node.kind)} ${node.name} (${node.kind}) — ${node.file}:${node.line}\n`);

    // Direct callees
    const callees = db.prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.target_id = n.id
      WHERE e.source_id = ? AND e.kind = 'calls'
    `).all(node.id);

    let filteredCallees = noTests ? callees.filter(c => !isTestFile(c.file)) : callees;
    if (filteredCallees.length > 0) {
      console.log(`  → Calls (${filteredCallees.length}):`);
      for (const c of filteredCallees) {
        console.log(`    → ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}`);
      }
    }

    // Direct callers
    let callers = db.prepare(`
      SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
      FROM edges e JOIN nodes n ON e.source_id = n.id
      WHERE e.target_id = ? AND e.kind = 'calls'
    `).all(node.id);

    // Also find callers via class hierarchy (if this is a method, include callers of parent/child overrides)
    if (node.kind === 'method' && node.name.includes('.')) {
      const methodName = node.name.split('.').pop();
      const relatedMethods = resolveMethodViaHierarchy(db, methodName);
      for (const rm of relatedMethods) {
        if (rm.id === node.id) continue;
        const extraCallers = db.prepare(`
          SELECT n.name, n.kind, n.file, n.line, e.kind as edge_kind
          FROM edges e JOIN nodes n ON e.source_id = n.id
          WHERE e.target_id = ? AND e.kind = 'calls'
        `).all(rm.id);
        callers.push(...extraCallers.map(c => ({ ...c, viaHierarchy: rm.name })));
      }
    }

    if (noTests) callers = callers.filter(c => !isTestFile(c.file));

    if (callers.length > 0) {
      console.log(`\n  ← Called by (${callers.length}):`);
      for (const c of callers) {
        const via = c.viaHierarchy ? ` (via ${c.viaHierarchy})` : '';
        console.log(`    ← ${kindIcon(c.kind)} ${c.name}  ${c.file}:${c.line}${via}`);
      }
    }

    // Transitive call chain (callers of callers, up to depth)
    if (depth > 1) {
      const visited = new Set([node.id]);
      let frontier = callers.map(c => ({ id: db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?').get(c.name, c.kind, c.file, c.line)?.id, name: c.name, file: c.file, line: c.line, kind: c.kind })).filter(c => c.id);
      
      for (let d = 2; d <= depth; d++) {
        const nextFrontier = [];
        for (const f of frontier) {
          if (visited.has(f.id)) continue;
          visited.add(f.id);
          const upstream = db.prepare(`
            SELECT n.name, n.kind, n.file, n.line
            FROM edges e JOIN nodes n ON e.source_id = n.id
            WHERE e.target_id = ? AND e.kind = 'calls'
          `).all(f.id);
          for (const u of upstream) {
            if (noTests && isTestFile(u.file)) continue;
            const uid = db.prepare('SELECT id FROM nodes WHERE name = ? AND kind = ? AND file = ? AND line = ?').get(u.name, u.kind, u.file, u.line)?.id;
            if (uid && !visited.has(uid)) {
              nextFrontier.push({ ...u, id: uid });
            }
          }
        }
        if (nextFrontier.length > 0) {
          console.log(`\n  ${'←'.repeat(d)} Transitive callers (depth ${d}, ${nextFrontier.length}):`);
          for (const n of nextFrontier.slice(0, 20)) {
            console.log(`    ${'  '.repeat(d-1)}← ${kindIcon(n.kind)} ${n.name}  ${n.file}:${n.line}`);
          }
          if (nextFrontier.length > 20) console.log(`    ... and ${nextFrontier.length - 20} more`);
        }
        frontier = nextFrontier;
        if (frontier.length === 0) break;
      }
    }

    if (callees.length === 0 && callers.length === 0) {
      console.log(`  (no call edges found — may be invoked dynamically or via re-exports)`);
    }
    console.log();
  }

  db.close();
}

/**
 * Function-level impact: what functions are transitively affected if this function changes?
 */
function fnImpact(name, customDbPath, opts = {}) {
  const db = openReadonly(customDbPath);
  const maxDepth = opts.depth || 5;
  const noTests = opts.noTests || false;

  let nodes = db.prepare(
    `SELECT * FROM nodes WHERE name LIKE ? AND kind IN ('function', 'method', 'class')`
  ).all(`%${name}%`);
  if (noTests) nodes = nodes.filter(n => !isTestFile(n.file));

  if (nodes.length === 0) {
    console.log(`No function/method/class matching "${name}"`);
    db.close();
    return;
  }

  for (const node of nodes.slice(0, 3)) {
    console.log(`\n💥 Function impact: ${kindIcon(node.kind)} ${node.name} — ${node.file}:${node.line}\n`);

    const visited = new Set([node.id]);
    const levels = new Map();
    let frontier = [node.id];

    for (let d = 1; d <= maxDepth; d++) {
      const nextFrontier = [];
      for (const fid of frontier) {
        // Find all callers of this function
        const callers = db.prepare(`
          SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
          FROM edges e JOIN nodes n ON e.source_id = n.id
          WHERE e.target_id = ? AND e.kind = 'calls'
        `).all(fid);

        for (const c of callers) {
          if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
            visited.add(c.id);
            nextFrontier.push(c.id);
            if (!levels.has(d)) levels.set(d, []);
            levels.get(d).push(c);
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }

    if (levels.size === 0) {
      console.log(`  No callers found.`);
    } else {
      for (const [level, fns] of [...levels].sort((a, b) => a[0] - b[0])) {
        console.log(`  ${'─'.repeat(level)} Level ${level} (${fns.length} functions):`);
        for (const f of fns.slice(0, 20)) {
          console.log(`    ${'  '.repeat(level)}↑ ${kindIcon(f.kind)} ${f.name}  ${f.file}:${f.line}`);
        }
        if (fns.length > 20) console.log(`    ... and ${fns.length - 20} more`);
      }
    }
    console.log(`\n  Total: ${visited.size - 1} functions transitively depend on ${node.name}\n`);
  }

  db.close();
}

/**
 * diff-impact: Parse a git diff (or staged changes) and report what's affected.
 * Finds changed functions, then traces their callers.
 */
function diffImpact(customDbPath, opts = {}) {
  const db = openReadonly(customDbPath);
  const noTests = opts.noTests || false;
  const maxDepth = opts.depth || 3;
  const diffTarget = opts.staged ? '--cached' : (opts.ref || 'HEAD');

  // Get the repo root from the db path
  const dbPath = findDbPath(customDbPath);
  const repoRoot = path.resolve(path.dirname(dbPath), '..');

  // Run git diff to get changed files and line ranges
  let diffOutput;
  try {
    const cmd = opts.staged
      ? `git diff --cached --unified=0 --no-color`
      : `git diff ${diffTarget} --unified=0 --no-color`;
    diffOutput = execSync(cmd, { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    console.log(`Failed to run git diff: ${e.message}`);
    db.close();
    return;
  }

  if (!diffOutput.trim()) {
    console.log('No changes detected.');
    db.close();
    return;
  }

  // Parse diff to extract file -> changed line ranges
  const changedRanges = new Map(); // file -> [{start, end}]
  let currentFile = null;
  for (const line of diffOutput.split('\n')) {
    // +++ b/src/foo.ts
    const fileMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (fileMatch) {
      currentFile = fileMatch[1];
      if (!changedRanges.has(currentFile)) changedRanges.set(currentFile, []);
      continue;
    }
    // @@ -10,5 +12,8 @@ — new side is +start,count
    const hunkMatch = line.match(/^@@ .+ \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch && currentFile) {
      const start = parseInt(hunkMatch[1]);
      const count = parseInt(hunkMatch[2] || '1');
      changedRanges.get(currentFile).push({ start, end: start + count - 1 });
    }
  }

  if (changedRanges.size === 0) {
    console.log('No parseable changes found.');
    db.close();
    return;
  }

  console.log(`\n📝 diff-impact: ${changedRanges.size} files changed\n`);

  // Find functions/methods that overlap with changed lines
  const affectedFunctions = [];
  for (const [file, ranges] of changedRanges) {
    if (noTests && isTestFile(file)) continue;

    // Get all function/method definitions in this file
    const defs = db.prepare(
      `SELECT * FROM nodes WHERE file = ? AND kind IN ('function', 'method', 'class') ORDER BY line`
    ).all(file);

    // Use actual end_line from tree-sitter node ranges, fallback to next definition - 1
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i];
      const endLine = def.end_line || (defs[i + 1] ? defs[i + 1].line - 1 : 999999);

      // Check if any changed range overlaps this function
      for (const range of ranges) {
        if (range.start <= endLine && range.end >= def.line) {
          affectedFunctions.push(def);
          break;
        }
      }
    }

    // If no functions matched but file changed, note the file
    if (defs.length === 0 || !defs.some(d => affectedFunctions.includes(d))) {
      const fileNode = db.prepare(`SELECT * FROM nodes WHERE file = ? AND kind = 'file'`).get(file);
      if (fileNode && !affectedFunctions.some(f => f.file === file)) {
        console.log(`  📄 ${file} (changed, no function-level match)`);
      }
    }
  }

  if (affectedFunctions.length === 0) {
    console.log('  No function-level changes detected (changes may be in imports, types, or config).');
    // Still show file-level impact
    console.log('\n  File-level impact:');
    for (const [file] of changedRanges) {
      if (noTests && isTestFile(file)) continue;
      const fileNode = db.prepare(`SELECT * FROM nodes WHERE file = ? AND kind = 'file'`).get(file);
      if (fileNode) {
        const importedBy = db.prepare(`
          SELECT n.file FROM edges e JOIN nodes n ON e.source_id = n.id
          WHERE e.target_id = ? AND e.kind IN ('imports', 'imports-type')
        `).all(fileNode.id);
        const filtered = noTests ? importedBy.filter(i => !isTestFile(i.file)) : importedBy;
        if (filtered.length > 0) {
          console.log(`    📄 ${file} ← imported by ${filtered.length} files`);
        }
      }
    }
    db.close();
    return;
  }

  console.log(`  🔧 ${affectedFunctions.length} functions changed:\n`);

  // For each affected function, trace callers
  const allAffected = new Set();
  for (const fn of affectedFunctions) {
    console.log(`  ${kindIcon(fn.kind)} ${fn.name} — ${fn.file}:${fn.line}`);

    // BFS callers
    const visited = new Set([fn.id]);
    let frontier = [fn.id];
    let totalCallers = 0;

    for (let d = 1; d <= maxDepth; d++) {
      const nextFrontier = [];
      for (const fid of frontier) {
        const callers = db.prepare(`
          SELECT DISTINCT n.id, n.name, n.kind, n.file, n.line
          FROM edges e JOIN nodes n ON e.source_id = n.id
          WHERE e.target_id = ? AND e.kind = 'calls'
        `).all(fid);
        for (const c of callers) {
          if (!visited.has(c.id) && (!noTests || !isTestFile(c.file))) {
            visited.add(c.id);
            nextFrontier.push(c.id);
            allAffected.add(`${c.file}:${c.name}`);
            totalCallers++;
          }
        }
      }
      frontier = nextFrontier;
      if (frontier.length === 0) break;
    }
    if (totalCallers > 0) {
      console.log(`    ↑ ${totalCallers} transitive callers (depth ${maxDepth})`);
    }
  }

  // Summary
  const affectedFiles = new Set();
  for (const key of allAffected) affectedFiles.add(key.split(':')[0]);
  console.log(`\n  📊 Summary: ${affectedFunctions.length} functions changed → ${allAffected.size} callers affected across ${affectedFiles.size} files\n`);

  db.close();
}

module.exports = { queryName, impactAnalysis, moduleMap, fileDeps, fnDeps, fnImpact, diffImpact };
