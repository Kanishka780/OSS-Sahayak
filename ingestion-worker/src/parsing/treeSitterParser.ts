import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import Parser from 'web-tree-sitter';
import { ParsedFile, ImportDetails, CallDetails } from 'shared';

const BIN_DIR = path.join(__dirname, '..', '..', 'bin');
const WASM_PARSER_URL = 'https://unpkg.com/web-tree-sitter@0.22.4/tree-sitter.wasm';
const WASM_TS_LANG_URL = 'https://unpkg.com/tree-sitter-wasms@0.1.11/out/tree-sitter-typescript.wasm';

const WASM_PARSER_PATH = path.join(BIN_DIR, 'tree-sitter.wasm');
const WASM_TS_LANG_PATH = path.join(BIN_DIR, 'tree-sitter-typescript.wasm');

let parserInstance: Parser | null = null;
let tsLanguage: Parser.Language | null = null;

// Download a file from a URL to a local path
async function downloadFile(url: string, dest: string): Promise<void> {
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const response = await axios({
    method: 'get',
    url: url,
    responseType: 'stream',
  });
  const writer = fs.createWriteStream(dest);
  response.data.pipe(writer);
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Ensure WASM files are downloaded and initialize Parser
export async function initParser(): Promise<void> {
  if (parserInstance && tsLanguage) return;

  if (!fs.existsSync(WASM_PARSER_PATH)) {
    console.log(`Downloading Tree-Sitter WASM runtime...`);
    await downloadFile(WASM_PARSER_URL, WASM_PARSER_PATH);
  }
  if (!fs.existsSync(WASM_TS_LANG_PATH)) {
    console.log(`Downloading Tree-Sitter TypeScript WASM grammar...`);
    await downloadFile(WASM_TS_LANG_URL, WASM_TS_LANG_PATH);
  }

  await Parser.init({
    locateFile() {
      return WASM_PARSER_PATH;
    }
  });

  parserInstance = new Parser();
  tsLanguage = await Parser.Language.load(WASM_TS_LANG_PATH);
  parserInstance.setLanguage(tsLanguage);
  console.log('Tree-sitter WASM parser initialized successfully.');
}

export async function parseSourceFile(filePath: string, content: string): Promise<ParsedFile> {
  await initParser();
  if (!parserInstance) throw new Error('Parser not initialized');

  const tree = parserInstance.parse(content);
  try {
    const root = tree.rootNode;

    const loc = content.split('\n').length;
    const imports: ImportDetails[] = [];
    
    // Track functions and classes
    const functions: ParsedFile['functions'] = [];
    const classes: ParsedFile['classes'] = [];

    // Recursive AST traversal
    function visit(node: Parser.SyntaxNode, currentFunction: any = null) {
      // 1. Extract Imports
      if (node.type === 'import_statement') {
        const sourceNode = node.childForFieldName('source');
        const source = sourceNode ? sourceNode.text.replace(/['"]/g, '') : '';
        
        const specifiers: string[] = [];
        // Look for named/default imports
        const clause = node.childForFieldName('value') || node;
        const namedImportsNode = clause.descendantsOfType('named_imports')[0];
        if (namedImportsNode) {
          for (let i = 0; i < namedImportsNode.namedChildCount; i++) {
            specifiers.push(namedImportsNode.namedChild(i)!.text);
          }
        } else {
          // Check for default import
          const identifierNode = clause.childForFieldName('name') || clause.descendantsOfType('identifier')[0];
          if (identifierNode) {
            specifiers.push(identifierNode.text);
          }
        }

        if (source) {
          imports.push({ importPath: source, specifiers });
        }
      }

      // 2. Extract Classes
      if (node.type === 'class_declaration') {
        const nameNode = node.childForFieldName('name');
        const name = nameNode ? nameNode.text : 'AnonymousClass';
        
        // Check superclass (extends)
        let superClass: string | undefined;
        const heritage = node.descendantsOfType('class_heritage')[0];
        if (heritage) {
          const extendsExpr = heritage.descendantsOfType('extends_clause')[0] || heritage;
          const valueNode = extendsExpr.namedChild(0);
          if (valueNode) {
            superClass = valueNode.text;
          }
        }

        classes.push({
          name,
          superClass,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
        });
      }

      // 3. Extract Functions / Methods
      let activeFunc = currentFunction;
      const isFunction = 
        node.type === 'function_declaration' || 
        node.type === 'generator_function_declaration' ||
        node.type === 'method_definition' ||
        node.type === 'arrow_function';

      if (isFunction) {
        let funcName = 'anonymous';
        if (node.type === 'function_declaration' || node.type === 'generator_function_declaration') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) funcName = nameNode.text;
        } else if (node.type === 'method_definition') {
          const nameNode = node.childForFieldName('name');
          if (nameNode) funcName = nameNode.text;
        } else if (node.type === 'arrow_function') {
          // Try to get parent variable declarator name
          let parent = node.parent;
          while (parent && parent.type !== 'variable_declarator' && parent.type !== 'lexical_declaration') {
            parent = parent.parent;
          }
          if (parent && parent.type === 'variable_declarator') {
            const nameNode = parent.childForFieldName('name');
            if (nameNode) funcName = nameNode.text;
          }
        }

        activeFunc = {
          name: funcName,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          calls: [] as CallDetails[],
        };
        functions.push(activeFunc);
      }

      // 4. Extract Call Expressions
      if (node.type === 'call_expression' && activeFunc) {
        const functionNode = node.childForFieldName('function');
        if (functionNode) {
          activeFunc.calls.push({
            callee: functionNode.text,
            line: node.startPosition.row + 1,
          });
        }
      }

      // Traverse children
      for (let i = 0; i < node.namedChildCount; i++) {
        visit(node.namedChild(i)!, activeFunc);
      }
    }

    visit(root);

    return {
      path: filePath,
      loc,
      imports,
      functions,
      classes,
    };
  } finally {
    tree.delete();
  }
}
