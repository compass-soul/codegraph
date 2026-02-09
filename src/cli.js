#!/usr/bin/env node
'use strict';

const { Command } = require('commander');
const { buildGraph } = require('./builder');
const { queryName, impactAnalysis, moduleMap, fileDeps, fnDeps, fnImpact, diffImpact } = require('./queries');
const path = require('path');

const program = new Command();
program.name('codegraph').description('Local code dependency graph tool').version('1.0.0');

program
  .command('build [dir]')
  .description('Parse repo and build graph in .codegraph/graph.db')
  .action((dir) => {
    const root = path.resolve(dir || '.');
    buildGraph(root);
  });

program
  .command('query <name>')
  .description('Find a function/class, show callers and callees')
  .option('-d, --db <path>', 'Path to graph.db')
  .action((name, opts) => {
    queryName(name, opts.db);
  });

program
  .command('impact <file>')
  .description('Show what depends on this file (transitive)')
  .option('-d, --db <path>', 'Path to graph.db')
  .action((file, opts) => {
    impactAnalysis(file, opts.db);
  });

program
  .command('map')
  .description('High-level module overview with most-connected nodes')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('-n, --limit <number>', 'Number of top nodes', '20')
  .action((opts) => {
    moduleMap(opts.db, parseInt(opts.limit));
  });

program
  .command('deps <file>')
  .description('Show what this file imports and what imports it')
  .option('-d, --db <path>', 'Path to graph.db')
  .action((file, opts) => {
    fileDeps(file, opts.db);
  });

program
  .command('fn <name>')
  .description('Function-level dependencies: callers, callees, and transitive call chain')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Transitive caller depth', '3')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .action((name, opts) => {
    fnDeps(name, opts.db, { depth: parseInt(opts.depth), noTests: !opts.tests });
  });

program
  .command('fn-impact <name>')
  .description('Function-level impact: what functions break if this one changes')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--depth <n>', 'Max transitive depth', '5')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .action((name, opts) => {
    fnImpact(name, opts.db, { depth: parseInt(opts.depth), noTests: !opts.tests });
  });

program
  .command('diff-impact [ref]')
  .description('Show impact of git changes (unstaged, staged, or vs a ref)')
  .option('-d, --db <path>', 'Path to graph.db')
  .option('--staged', 'Analyze staged changes instead of unstaged')
  .option('--depth <n>', 'Max transitive caller depth', '3')
  .option('-T, --no-tests', 'Exclude test/spec files from results')
  .action((ref, opts) => {
    diffImpact(opts.db, { ref, staged: opts.staged, depth: parseInt(opts.depth), noTests: !opts.tests });
  });

program.parse();
