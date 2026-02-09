# codegraph

Local code dependency graph CLI. Parse codebases with [tree-sitter](https://tree-sitter.github.io/), store in SQLite, query at file and function level. No network calls, no data leaves your machine.

## Install

```bash
git clone https://github.com/compass-soul/codegraph.git
cd codegraph
npm install
npm link  # makes `codegraph` available globally
```

## Usage

### Build the graph

```bash
cd your-project
codegraph build
# → .codegraph/graph.db created
```

Parses all `.js`, `.ts`, `.tsx`, `.jsx`, `.mjs`, `.cjs` files. Skips `node_modules`, `dist`, `build`, `.git`, etc. Also supports `.tf`/`.hcl` (Terraform) if the grammar is available.

### Query a symbol

```bash
codegraph query routeReply
```

Find any function, class, or method by name. Shows callers and callees.

### File dependencies

```bash
codegraph deps src/auto-reply/reply/route-reply.ts
```

What does this file import? What imports it? What's defined in it?

### File-level impact analysis

```bash
codegraph impact route-reply.ts
```

Transitive reverse dependency trace — every file that would be affected if this file changes.

### Module map

```bash
codegraph map          # top 20 most-connected files
codegraph map -n 50    # top 50
```

High-level overview ranked by inbound edges (how many files depend on each).

### Function-level dependencies

```bash
codegraph fn routeReply              # callers, callees, transitive chain
codegraph fn routeReply --no-tests   # exclude test/spec files
codegraph fn routeReply --depth 5    # deeper transitive trace
```

Shows what a function calls, what calls it, and the transitive call chain up to configurable depth. Resolves calls through import context and class hierarchy.

### Function-level impact

```bash
codegraph fn-impact deliverOutboundPayloads --no-tests
```

Like `impact` but at function granularity — traces which functions would break if this one changes.

### Diff impact

```bash
codegraph diff-impact              # unstaged changes vs working tree
codegraph diff-impact --staged     # staged changes
codegraph diff-impact HEAD~3       # vs a specific ref
codegraph diff-impact --no-tests   # exclude test files from results
```

Parses a git diff, finds which functions overlap with changed lines, traces their callers. Perfect for pre-PR review — "what does this change actually affect?"

## Common flags

| Flag | Description |
|------|-------------|
| `-d, --db <path>` | Custom path to `graph.db` |
| `-T, --no-tests` | Exclude `.test.`, `.spec.`, `__test__` files |
| `--depth <n>` | Transitive trace depth (default varies by command) |

## How it works

1. **Parse**: tree-sitter parses every source file into an AST
2. **Extract**: Functions, classes, methods, imports, exports, and call sites are extracted
3. **Resolve**: Imports are resolved to actual files (handles `.js`→`.ts` ESM convention, `tsconfig.json` path aliases, `baseUrl`)
4. **Store**: Everything goes into SQLite (nodes + edges)
5. **Query**: All queries run against the local SQLite DB

### Call resolution

Calls are resolved with priority:
1. **Import-aware**: If you `import { foo } from './bar'`, a call to `foo` links to `bar`'s definition
2. **Same-file**: Definitions in the current file
3. **Method hierarchy**: Method calls resolved through `extends` chains
4. **Global fallback**: Match by name across codebase

### What it tracks

- **Nodes**: files, functions, arrow functions, classes, methods
- **Edges**: imports, imports-type (type-only), calls, extends, reexports

## CLAUDE.md / AI Agent Integration

Add this to your project's `CLAUDE.md` (or equivalent agent instructions file) to help AI coding agents use codegraph effectively:

```markdown
## Code Navigation

This project has a codegraph database at `.codegraph/graph.db`. Use it to understand the codebase:

- **Before modifying a function**: `codegraph fn <name> --no-tests` — see what calls it and what it calls
- **Before modifying a file**: `codegraph deps <file>` — see import relationships
- **To assess PR impact**: `codegraph diff-impact --no-tests` — see what your changes affect
- **To find entry points**: `codegraph map` — shows most-connected files
- **To trace breakage**: `codegraph fn-impact <name> --no-tests` — what breaks if this function changes

Rebuild the graph after major structural changes: `codegraph build`

### Workflow
1. Run `codegraph fn <function> --no-tests` before changing any function
2. Check callers — will your change break them?
3. After changes, run `codegraph diff-impact --no-tests` to verify impact scope
4. If impact is larger than expected, review before committing
```

## Performance

On a ~3200-file TypeScript project (OpenClaw):
- **Build time**: ~10 seconds
- **14,878 nodes**, **109,223 edges**
- **Query time**: <100ms (SQLite is fast)
- **DB size**: ~5MB

## Limitations

- **Name-based call resolution**: If two files define `init()`, ambiguity remains (import-aware resolution helps but isn't perfect)
- **No type inference**: Doesn't use TypeScript's type system for overload/interface resolution
- **Dynamic calls missed**: `obj[method]()`, computed property access, `apply`/`call`/`bind` patterns
- **Approximate function boundaries**: Uses "next definition" as end boundary (no scope analysis)
- **JS/TS only**: No Python, Go, Rust, etc. (tree-sitter grammars exist — contributions welcome)

## License

MIT
