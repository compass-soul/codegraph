'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function openDb(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      file TEXT NOT NULL,
      line INTEGER,
      end_line INTEGER,
      UNIQUE(name, kind, file, line)
    );
    CREATE TABLE IF NOT EXISTS edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      confidence REAL DEFAULT 1.0,
      dynamic INTEGER DEFAULT 0,
      FOREIGN KEY(source_id) REFERENCES nodes(id),
      FOREIGN KEY(target_id) REFERENCES nodes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
    CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file);
    CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
    CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
    CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
    CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
  `);

  // Migration: add columns if they don't exist (backward compat)
  try { db.exec('ALTER TABLE nodes ADD COLUMN end_line INTEGER'); } catch {}
  try { db.exec('ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 1.0'); } catch {}
  try { db.exec('ALTER TABLE edges ADD COLUMN dynamic INTEGER DEFAULT 0'); } catch {}
}

function findDbPath(customPath) {
  if (customPath) return path.resolve(customPath);
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.codegraph', 'graph.db');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), '.codegraph', 'graph.db');
}

module.exports = { openDb, initSchema, findDbPath };
