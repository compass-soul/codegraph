'use strict';

const Parser = require('tree-sitter');
const JavaScript = require('tree-sitter-javascript');
const TypeScript = require('tree-sitter-typescript');
let HCL, Python;
try { HCL = require('@tree-sitter-grammars/tree-sitter-hcl'); } catch { HCL = null; }
try { Python = require('tree-sitter-python'); } catch { Python = null; }

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

  let pyParser = null;
  if (Python) {
    try {
      pyParser = new Parser();
      pyParser.setLanguage(Python);
    } catch (e) {
      console.warn(`⚠ Python parser failed to initialize: ${e.message}. Python files will be skipped.`);
      pyParser = null;
    }
  }

  return { jsParser, tsParser, tsxParser, hclParser, pyParser };
}

function getParser(parsers, filePath) {
  if (filePath.endsWith('.tsx')) return parsers.tsxParser;
  if (filePath.endsWith('.ts') || filePath.endsWith('.d.ts')) return parsers.tsParser;
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs'))
    return parsers.jsParser;
  if (filePath.endsWith('.py') && parsers.pyParser) return parsers.pyParser;
  if ((filePath.endsWith('.tf') || filePath.endsWith('.hcl')) && parsers.hclParser)
    return parsers.hclParser;
  return null;
}

/**
 * Get the end line (1-indexed) from a tree-sitter node.
 */
function nodeEndLine(node) {
  return node.endPosition.row + 1;
}

/**
 * Extract symbols from a JS/TS parsed AST.
 * Returns { definitions: [], calls: [], imports: [], classes: [], exports: [] }
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
          definitions.push({ name: nameNode.text, kind: 'function', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const cls = { name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) };
          definitions.push(cls);
          const heritage = node.childForFieldName('heritage') || findChild(node, 'class_heritage');
          if (heritage) {
            const superName = extractSuperclass(heritage);
            if (superName) {
              classes.push({ name: nameNode.text, extends: superName, line: node.startPosition.row + 1 });
            }
            // Check for implements
            const implementsList = extractImplements(heritage);
            for (const iface of implementsList) {
              classes.push({ name: nameNode.text, implements: iface, line: node.startPosition.row + 1 });
            }
          }
        }
        break;
      }

      case 'method_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          let parentClass = findParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          definitions.push({ name: fullName, kind: 'method', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      // Improvement #4: interface and type alias declarations
      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'interface', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          // Extract method signatures from interface body
          const body = node.childForFieldName('body') || findChild(node, 'interface_body') || findChild(node, 'object_type');
          if (body) {
            extractInterfaceMethods(body, nameNode.text, definitions);
          }
        }
        break;
      }

      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'type', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }
        break;
      }

      case 'lexical_declaration':
      case 'variable_declaration': {
        for (let i = 0; i < node.childCount; i++) {
          const declarator = node.child(i);
          if (declarator && declarator.type === 'variable_declarator') {
            const nameN = declarator.childForFieldName('name');
            const valueN = declarator.childForFieldName('value');
            if (nameN && valueN && (valueN.type === 'arrow_function' || valueN.type === 'function_expression' || valueN.type === 'function')) {
              definitions.push({ name: nameN.text, kind: 'function', line: node.startPosition.row + 1, endLine: nodeEndLine(valueN) });
            }
          }
        }
        break;
      }

      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn) {
          const callInfo = extractCallInfo(fn, node);
          if (callInfo) {
            calls.push(callInfo);
          }
        }
        break;
      }

      case 'import_statement': {
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
          if (decl.type === 'function_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'function', line: node.startPosition.row + 1 });
          } else if (decl.type === 'class_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'class', line: node.startPosition.row + 1 });
          } else if (decl.type === 'interface_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'interface', line: node.startPosition.row + 1 });
          } else if (decl.type === 'type_alias_declaration') {
            const n = decl.childForFieldName('name');
            if (n) exports.push({ name: n.text, kind: 'type', line: node.startPosition.row + 1 });
          }
        }
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

/**
 * Extract method signatures from an interface body node.
 */
function extractInterfaceMethods(bodyNode, interfaceName, definitions) {
  for (let i = 0; i < bodyNode.childCount; i++) {
    const child = bodyNode.child(i);
    if (!child) continue;
    // method_signature, property_signature with function type
    if (child.type === 'method_signature' || child.type === 'property_signature') {
      const nameNode = child.childForFieldName('name');
      if (nameNode) {
        definitions.push({
          name: `${interfaceName}.${nameNode.text}`,
          kind: 'method',
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1
        });
      }
    }
  }
}

/**
 * Extract implemented interface names from class_heritage.
 */
function extractImplements(heritage) {
  const interfaces = [];
  for (let i = 0; i < heritage.childCount; i++) {
    const child = heritage.child(i);
    if (!child) continue;
    // In TS tree-sitter, implements clause shows up after "implements" keyword
    if (child.text === 'implements') {
      // Collect all identifiers after "implements" until end or next keyword
      for (let j = i + 1; j < heritage.childCount; j++) {
        const next = heritage.child(j);
        if (!next) continue;
        if (next.type === 'identifier') {
          interfaces.push(next.text);
        } else if (next.type === 'type_identifier') {
          interfaces.push(next.text);
        }
        // Recurse into comma-separated lists
        if (next.childCount > 0) {
          const found = extractImplementsFromNode(next);
          interfaces.push(...found);
        }
      }
      break;
    }
    // Also try child nodes that may contain implements_clause
    if (child.type === 'implements_clause') {
      const found = extractImplementsFromNode(child);
      interfaces.push(...found);
    }
  }
  return interfaces;
}

function extractImplementsFromNode(node) {
  const result = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type === 'identifier' || child.type === 'type_identifier') {
      result.push(child.text);
    }
    if (child.childCount > 0) {
      result.push(...extractImplementsFromNode(child));
    }
  }
  return result;
}

/**
 * Improvement #5: Extract call info with dynamic call pattern detection.
 */
function extractCallInfo(fn, callNode) {
  // Standard call: foo() or obj.foo()
  if (fn.type === 'identifier') {
    return { name: fn.text, line: callNode.startPosition.row + 1 };
  }

  if (fn.type === 'member_expression') {
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    if (!prop) return null;

    // Detect .call(), .apply(), .bind() patterns
    if (prop.text === 'call' || prop.text === 'apply' || prop.text === 'bind') {
      if (obj && obj.type === 'identifier') {
        // fn.call(...) -> the real target is fn
        return { name: obj.text, line: callNode.startPosition.row + 1, dynamic: true };
      }
      if (obj && obj.type === 'member_expression') {
        const innerProp = obj.childForFieldName('property');
        if (innerProp) {
          return { name: innerProp.text, line: callNode.startPosition.row + 1, dynamic: true };
        }
      }
    }

    // Detect obj[stringLiteral]() — computed property with string literal
    if (prop.type === 'string' || prop.type === 'string_fragment') {
      const methodName = prop.text.replace(/['"]/g, '');
      if (methodName) {
        return { name: methodName, line: callNode.startPosition.row + 1, dynamic: true };
      }
    }

    return { name: prop.text, line: callNode.startPosition.row + 1 };
  }

  // Detect subscript expression: obj["method"]()
  if (fn.type === 'subscript_expression') {
    const index = fn.childForFieldName('index');
    if (index && (index.type === 'string' || index.type === 'template_string')) {
      const methodName = index.text.replace(/['"`]/g, '');
      if (methodName && !methodName.includes('$')) {
        return { name: methodName, line: callNode.startPosition.row + 1, dynamic: true };
      }
    }
  }

  return null;
}

function findChild(node, type) {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === type) return node.child(i);
  }
  return null;
}

function extractSuperclass(heritage) {
  for (let i = 0; i < heritage.childCount; i++) {
    const child = heritage.child(i);
    if (child.type === 'identifier') return child.text;
    if (child.type === 'member_expression') return child.text;
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

function extractImportNames(node) {
  const names = [];
  function scan(n) {
    if (n.type === 'import_specifier' || n.type === 'export_specifier') {
      const nameNode = n.childForFieldName('name') || n.childForFieldName('alias');
      if (nameNode) names.push(nameNode.text);
      else names.push(n.text);
    } else if (n.type === 'identifier' && n.parent && n.parent.type === 'import_clause') {
      names.push(n.text);
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
 */
function extractHCLSymbols(tree, filePath) {
  const definitions = [];
  const imports = [];

  function walk(node) {
    if (node.type === 'block') {
      const children = [];
      for (let i = 0; i < node.childCount; i++) children.push(node.child(i));

      const identifiers = children.filter(c => c.type === 'identifier');
      const strings = children.filter(c => c.type === 'string_lit');

      if (identifiers.length > 0) {
        const blockType = identifiers[0].text;
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
          definitions.push({ name, kind: blockType, line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
        }

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

/**
 * Improvement #2: Extract symbols from Python files.
 */
function extractPythonSymbols(tree, filePath) {
  const definitions = [];
  const calls = [];
  const imports = [];
  const classes = [];
  const exports = [];

  function walk(node) {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          // Check for decorators
          let decorators = [];
          if (node.previousSibling && node.previousSibling.type === 'decorator') {
            decorators.push(node.previousSibling.text);
          }
          // Check if inside a class (method)
          const parentClass = findPythonParentClass(node);
          const fullName = parentClass ? `${parentClass}.${nameNode.text}` : nameNode.text;
          const kind = parentClass ? 'method' : 'function';
          definitions.push({ name: fullName, kind, line: node.startPosition.row + 1, endLine: nodeEndLine(node), decorators });
        }
        break;
      }

      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          definitions.push({ name: nameNode.text, kind: 'class', line: node.startPosition.row + 1, endLine: nodeEndLine(node) });
          // Check for superclasses
          const superclasses = node.childForFieldName('superclasses') || findChild(node, 'argument_list');
          if (superclasses) {
            for (let i = 0; i < superclasses.childCount; i++) {
              const child = superclasses.child(i);
              if (child && child.type === 'identifier') {
                classes.push({ name: nameNode.text, extends: child.text, line: node.startPosition.row + 1 });
              }
            }
          }
        }
        break;
      }

      case 'decorated_definition': {
        // Walk children - the actual def/class is a child
        for (let i = 0; i < node.childCount; i++) {
          walk(node.child(i));
        }
        return; // don't walk children again
      }

      case 'call': {
        const fn = node.childForFieldName('function');
        if (fn) {
          let callName = null;
          if (fn.type === 'identifier') callName = fn.text;
          else if (fn.type === 'attribute') {
            const attr = fn.childForFieldName('attribute');
            if (attr) callName = attr.text;
          }
          if (callName) {
            calls.push({ name: callName, line: node.startPosition.row + 1 });
          }
        }
        break;
      }

      case 'import_statement': {
        // import x, import x.y
        const names = [];
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (child && (child.type === 'dotted_name' || child.type === 'aliased_import')) {
            const name = child.type === 'aliased_import' ?
              (child.childForFieldName('alias') || child.childForFieldName('name'))?.text :
              child.text;
            if (name) names.push(name);
          }
        }
        if (names.length > 0) {
          imports.push({ source: names[0], names, line: node.startPosition.row + 1, pythonImport: true });
        }
        break;
      }

      case 'import_from_statement': {
        // from x import y, z
        let source = '';
        const names = [];
        for (let i = 0; i < node.childCount; i++) {
          const child = node.child(i);
          if (!child) continue;
          if (child.type === 'dotted_name' || child.type === 'relative_import') {
            if (!source) source = child.text;
            else names.push(child.text);
          }
          if (child.type === 'aliased_import') {
            const n = child.childForFieldName('name') || child.child(0);
            if (n) names.push(n.text);
          }
          // Wildcard import
          if (child.type === 'wildcard_import') {
            names.push('*');
          }
        }
        if (source) {
          imports.push({ source, names, line: node.startPosition.row + 1, pythonImport: true });
        }
        break;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }

  function findPythonParentClass(node) {
    let current = node.parent;
    while (current) {
      if (current.type === 'class_definition') {
        const nameNode = current.childForFieldName('name');
        return nameNode ? nameNode.text : null;
      }
      current = current.parent;
    }
    return null;
  }

  walk(tree.rootNode);
  return { definitions, calls, imports, classes, exports };
}

module.exports = { createParsers, getParser, extractSymbols, extractHCLSymbols, extractPythonSymbols };
