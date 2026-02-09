'use strict';

const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript');
let HCL;
try { HCL = require('@tree-sitter-grammars/tree-sitter-hcl'); } catch { HCL = null; }

function createParsers() {
  const jsParser = new Parser();
  jsParser.setLanguage(JavaScript);

  const tsParser = new Parser();
  tsParser.setLanguage(TypeScript.typescript);

  const tsxParser = new Parser();
  tsxParser.setLanguage(TypeScript.tsx);

  let hclParser = null;
  if (HCL) {
    try {
      hclParser = new Parser();
      hclParser.setLanguage(HCL);
    } catch (e) {
      console.warn(`⚠ HCL parser failed to initialize: ${e.message}. HCL files will be skipped.`);
      hclParser = null;
    }
  }

  return { jsParser, tsParser, tsxParser, hclParser };
}

function getParser(parsers, filePath) {
  if (filePath.endsWith('.tsx')) return parsers.tsxParser;
  if (filePath.endsWith('.ts')) return parsers.tsParser;
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs'))
    return parsers.jsParser;
  if ((filePath.endsWith('.tf') || filePath.endsWith('.hcl')) && parsers.hclParser)
    return parsers.hclParser;
  return null;
}

/**
 * Extract symbols from a parsed AST.
 * Returns { definitions: [], calls: [], imports: [], classes: [] }
 */
function extractSymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function walk(node) {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'function', line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const cls = { name: nameNode.text, kind: 'class', line: node.startPosition.row + 1 };
          definitions.push(cls);
          // Check for extends
          const heritage = node.childForFieldName('heritage') || findChild(node, 'class_heritage');
          if (heritage) {
            // Extract the superclass name
            const superName = extractSuperclass(heritage);
            if (superName) {
              classes.push({ name: nameNode.text, extends: superName, line: node.startPosition.row + 1 });
            }
          }
        }
        break;
      }

      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          // Find parent class name
          let parentClass = findParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1 });
        }
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        // Check for arrow functions: const foo = () => ...
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i);
          if (declarator && declarator.type === 'variable_declarator') {
            const nameN = declarator.childForFieldName('name');
            const valueN = declarator.childForFieldName('value');
            if (nameN && valueN && (valueN.type === 'arrow_function' || valueN.type === 'function_expression' || valueN.type === 'function')) {
              definitions.push({ name: nameN.text, kind: 'function', line: node.startPosition.row + 1 });
            }
          }
        }
        break;
      }

      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          const callName = extractCallName(fn);
          if (callName) {
            calls.push({ name: callName, line: node.startPosition.row + 1 });
          }
        }
        break;
      }

      case 'import_statement': {
        // Skip type-only imports (import type { X } from ...) — they don't create runtime dependencies
        const isTypeOnly = node.text.startsWith('import type');
        const source = node.childForFieldName('source') || findChild(node, 'string');
        if (source) {
          const modPath = source.text.replace(/['"]/g, '');
          const names = extractImportNames(node);
          imports.push({ source: modPath, names, line: node.startPosition.row + 1, typeOnly: isTypeOnly });
        }
        break;
      }

      case 'export_statement': {
        const decl = node.childForFieldName('declaration');
        if (decl) {
          // export function foo / export class Bar
          if (decl.type === 'function_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'function', line: node.startPosition.row + 1 });
          } else if (decl.type === 'class_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'class', line: node.startPosition.row + 1 });
          }
        }
        // re-exports: export { x } from './y'
        const source = node.childForFieldName('source') || findChild(node, 'string');
        if (source && !decl) {
          const modPath = source.text.replace(/['"]/g, '');
          imports.push({ source: modPath, names: extractImportNames(node), line: node.startPosition.row + 1, reexport: true });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

function findChild(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === type) return node.child(i);
  }
  return null;
}

function extractSuperclass(heritage) {
  // Walk heritage looking for identifier
  for (let i = 0; i < heritage.childCount; i++) {
    const child = heritage.child(i);
    if (child.type === 'identifier') return child.text;
    if (child.type === 'member_expression') return child.text;
    // Recurse
    const found = extractSuperclass(child);
    if (found) return found;
  }
  return null;
}

function findParentClass(node) {
  let current = node.parent;
  while (current) {
    if (current.type === 'class_declaration' || current.type === 'class') {
      const nameNode = current.childForFieldName('name');
      return nameNode ? nameNode.text : null;
    }
    current = current.parent;
  }
  return null;
}

function extractCallName(fn) {
  if (fn.type === 'identifier') return fn.text;
  if (fn.type === 'member_expression') {
    const prop = fn.childForFieldName('property');
    return prop ? prop.text : fn.text;
  }
  return null;
}

function extractImportNames(node) {
  const names = [];
  function scan(n) {
    if (n.type === 'import_specifier' || n.type === 'export_specifier') {
      const nameNode = n.childForFieldName('name') || n.childForFieldName('alias');
      if (nameNode) names.push(nameNode.text);
      else names.push(n.text);
    } else if (n.type === 'identifier' && n.parent && n.parent.type === 'import_clause') {
      names.push(n.text); // default import
    } else if (n.type === 'namespace_import') {
      names.push(n.text);
    }
    for (let i = 0; i < n.childCount; i++) scan(n.child(i));
  }
  scan(node);
  return names;
}

/**
 * Extract symbols from HCL (Terraform) files.
 * Tracks resource/data/variable/module/output blocks and module source references.
 */
function extractHCLSymbols(tree, filePath) {
  const definitions = [];
  const imports = [];

  function walk(node) {
    // HCL block: resource "type" "name" { ... }
    if (node.type === 'block') {
      const children = [];
      for (let i = 0; i < node.childCount; i++) children.push(node.child(i));

      const identifiers = children.filter(c => c.type === 'identifier');
      const strings = children.filter(c => c.type === 'string_lit');

      if (identifiers.length > 0) {
        const blockType = identifiers[0].text; // resource, variable, data, module, output, locals
        let name = '';

        if (blockType === 'resource' && strings.length >= 2) {
          name = `${strings[0].text.replace(/"/g, '')}.${strings[1].text.replace(/"/g, '')}`;
        } else if (blockType === 'data' && strings.length >= 2) {
          name = `data.${strings[0].text.replace(/"/g, '')}.${strings[1].text.replace(/"/g, '')}`;
        } else if ((blockType === 'variable' || blockType === 'output' || blockType === 'module') && strings.length >= 1) {
          name = `${blockType}.${strings[0].text.replace(/"/g, '')}`;
        } else if (blockType === 'locals') {
          name = 'locals';
        } else if (blockType === 'terraform' || blockType === 'provider') {
          name = blockType;
          if (strings.length >= 1) name += `.${strings[0].text.replace(/"/g, '')}`;
        }

        if (name) {
          definitions.push({ name, kind: blockType, line: node.startPosition.row + 1 });
        }

        // Module source = dependency on another module
        if (blockType === 'module') {
          const body = children.find(c => c.type === 'body');
          if (body) {
            for (let i = 0; i < body.childCount; i++) {
              const attr = body.child(i);
              if (attr && attr.type === 'attribute') {
                const key = attr.childForFieldName('key') || attr.child(0);
                const val = attr.childForFieldName('val') || attr.child(2);
                if (key && key.text === 'source' && val) {
                  const src = val.text.replace(/"/g, '');
                  if (src.startsWith('./') || src.startsWith('../')) {
                    imports.push({ source: src, names: [], line: attr.startPosition.row + 1 });
                  }
                }
              }
            }
          }
        }
      }
    }

    for (let i = 0; i < node.childCount; i++) walk(node.child(i));
  }

  walk(tree.rootNode);
  return { definitions, calls: [], imports, classes: [], exports: [] };
}

module.exports = { createParsers, getParser, extractSymbols, extractHCLSymbols };
