import * as ts from 'typescript';

interface SpanEdit {
  start: number;
  end: number;
  text: string;
}

function hasPrivateModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const mods = ts.getModifiers(node);
  return Boolean(mods?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword));
}

function getScriptKind(filePathOrLang: string): ts.ScriptKind {
  const lower = filePathOrLang.toLowerCase();
  if (lower.endsWith('.tsx') || lower === 'tsx') return ts.ScriptKind.TSX;
  if (lower.endsWith('.jsx') || lower === 'jsx') return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/.test(lower) || lower === 'js' || lower === 'javascript') {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

export function skeletonizeTypeScriptAst(code: string, filePathOrLang = '.ts'): string {
  const kind = getScriptKind(filePathOrLang);
  const sf = ts.createSourceFile('file' + filePathOrLang, code, ts.ScriptTarget.Latest, true, kind);
  const edits: SpanEdit[] = [];

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, code);
  let token = scanner.scan();
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia) {
      const raw = scanner.getTokenText();
      if (!raw.startsWith('///')) {
        edits.push({ start: scanner.getTokenPos(), end: scanner.getTextPos(), text: '' });
      }
    } else if (token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const raw = scanner.getTokenText();
      if (raw.startsWith('/**')) {
        const summary = raw
          .replace(/^\/\*\*|\*\/$/g, '')
          .split('\n')
          .map((l) => l.replace(/^\s*\*\s?/, '').trim())
          .find((l) => l.length > 0 && !l.startsWith('@'));
        edits.push({
          start: scanner.getTokenPos(),
          end: scanner.getTextPos(),
          text: summary ? `/** ${summary} */` : ''
        });
      } else {
        edits.push({ start: scanner.getTokenPos(), end: scanner.getTextPos(), text: '' });
      }
    }
    token = scanner.scan();
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    ) {
      const isPrivateName =
        'name' in node && node.name && ts.isPrivateIdentifier(node.name as ts.Node);
      if (hasPrivateModifier(node) || isPrivateName) {
        edits.push({ start: node.getFullStart(), end: node.getEnd(), text: '' });
        return;
      }
      if (node.body) {
        edits.push({ start: node.body.getStart(sf), end: node.body.getEnd(), text: '{ ... }' });
      }
      return;
    }

    if (ts.isPropertyDeclaration(node)) {
      const init = node.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        if (hasPrivateModifier(node) || ts.isPrivateIdentifier(node.name)) {
          edits.push({ start: node.getFullStart(), end: node.getEnd(), text: '' });
          return;
        }
        if (ts.isBlock(init.body)) {
          edits.push({ start: init.body.getStart(sf), end: init.body.getEnd(), text: '{ ... }' });
        } else if (init.body.getText(sf).includes('\n')) {
          edits.push({ start: init.body.getStart(sf), end: init.body.getEnd(), text: '...' });
        }
        return;
      }
    }

    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const init = decl.initializer;
        if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          if (ts.isBlock(init.body)) {
            edits.push({ start: init.body.getStart(sf), end: init.body.getEnd(), text: '{ ... }' });
          } else if (init.body.getText(sf).includes('\n')) {
            edits.push({ start: init.body.getStart(sf), end: init.body.getEnd(), text: '...' });
          }
        }
      }
      return;
    }

    ts.forEachChild(node, visit);
  };

  visit(sf);

  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += code.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += code.slice(cursor);

  return out
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(/^( {2,})/, (_, s: string) => ' '.repeat(Math.ceil(s.length / 2))))
    .join('\n')
    .trim();
}

function skeletonizeRuby(code: string): string {
  const withoutBlockComments = code.replace(/^=begin[\s\S]*?^=end\s*$/gm, '');
  const lines = withoutBlockComments.split('\n');
  const out: string[] = [];
  let depth = 0;
  let defDepth: number | null = null;
  const openRe = /^\s*(?:class|module|def|if|unless|case|while|until|for|begin)\b|\bdo\s*(?:\|[^|]*\|)?\s*$/;

  for (const line of lines) {
    const cleaned = line.replace(/(^|\s)#.*$/, '$1');
    const trimmed = cleaned.trim();
    if (!trimmed) {
      if (defDepth === null && out[out.length - 1] !== '') out.push('');
      continue;
    }
    const isEnd = /^end\b/.test(trimmed);
    const isDef = /^def\s+/.test(trimmed);
    const opens = !isEnd && openRe.test(trimmed);

    if (defDepth !== null) {
      if (opens) depth++;
      if (isEnd) {
        depth--;
        if (depth <= defDepth) {
          out.push(line);
          defDepth = null;
        }
      }
      continue;
    }

    out.push(cleaned);
    if (isDef) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      out.push(`${indent}  ...`);
      defDepth = depth;
      depth++;
    } else if (opens) {
      depth++;
    } else if (isEnd) {
      depth = Math.max(0, depth - 1);
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function skeletonizeMarkup(code: string): string {
  let out = code.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, (m, attrs) =>
    m.length > 200 ? `<svg${attrs}><!-- [SVG omitted] --></svg>` : m
  );
  out = out.replace(/<style\b([^>]*)>[\s\S]*?<\/style>/gi, (m, attrs) =>
    m.length > 250 ? `<style${attrs}>/* [CSS omitted] */</style>` : m
  );
  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, inner) =>
    m.length > 250 ? `<script${attrs}>\n${skeletonizeTypeScriptAst(inner, '.js')}\n</script>` : m
  );

  const lines = out.split('\n');
  const compacted: string[] = [];
  let lastTag = '';
  let repeatCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const tagMatch = trimmed.match(/^<([a-zA-Z0-9-]+)(?:\s|>)/);
    const tag = tagMatch ? tagMatch[1].toLowerCase() : '';
    const isSelfContained = tag && trimmed.endsWith(`</${tag}>`);

    if (isSelfContained && tag === lastTag) {
      repeatCount++;
      if (repeatCount <= 2) {
        compacted.push(line);
      }
    } else {
      if (repeatCount > 2) {
        compacted.push(`<!-- ... [${repeatCount - 2} more <${lastTag}> elements] -->`);
      }
      lastTag = isSelfContained ? tag : '';
      repeatCount = isSelfContained ? 1 : 0;
      compacted.push(line);
    }
  }
  if (repeatCount > 2) {
    compacted.push(`<!-- ... [${repeatCount - 2} more <${lastTag}> elements] -->`);
  }
  return compacted.join('\n').trim();
}

function skeletonizeSql(code: string): string {
  const cleaned = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--.*$/gm, '');
  return cleaned
    .replace(/INSERT\s+INTO\s+[\s\S]*?VALUES\s*([\s\S]*?);/gi, (full, valuesPart: string) => {
      if (full.length < 280) return full;
      const rows = valuesPart.split(/\),\s*\(/);
      if (rows.length <= 2) return full;
      const head = full.slice(0, full.indexOf(valuesPart));
      return `${head}${rows[0]}), (${rows[1]}) /* ... [${rows.length - 2} more rows omitted] */;`;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function skeletonizeYaml(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];
  let blockIndent: number | null = null;
  let blockLines = 0;
  let listIndent: number | null = null;
  let listCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;

    if (blockIndent !== null) {
      if (indent > blockIndent) {
        blockLines++;
        if (blockLines <= 2) out.push(line);
        else if (blockLines === 3) out.push(`${' '.repeat(indent)}# ... [block truncated]`);
        continue;
      }
      blockIndent = null;
      blockLines = 0;
    }

    if (/^-\s+/.test(trimmed)) {
      if (listIndent === indent) {
        listCount++;
        if (listCount <= 6) out.push(line);
        else if (listCount === 7) out.push(`${' '.repeat(indent)}# ... [more list items]`);
        continue;
      }
      listIndent = indent;
      listCount = 1;
    } else if (listIndent !== null && indent <= listIndent) {
      listIndent = null;
      listCount = 0;
    }

    out.push(line);
    if (/:\s*[|>][-+]?\s*$/.test(trimmed)) {
      blockIndent = indent;
      blockLines = 0;
    }
  }
  return out.join('\n').trim();
}

function skeletonizeShell(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];
  let depth = 0;
  let skipDepth: number | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#') && !trimmed.startsWith('#!')) continue;

    const scrubbed = trimmed.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''");
    const opens = (scrubbed.match(/\{/g) || []).length;
    const closes = (scrubbed.match(/\}/g) || []).length;

    if (skipDepth !== null) {
      depth += opens - closes;
      if (depth <= skipDepth) {
        out[out.length - 1] = `${out[out.length - 1]} ... }`;
        skipDepth = null;
      }
      continue;
    }

    if (/^(?:function\s+)?[a-zA-Z_][a-zA-Z0-9_]*\s*(?:\(\))?\s*\{$/.test(trimmed) && opens > closes) {
      out.push(line);
      skipDepth = depth;
      depth += opens - closes;
    } else {
      out.push(line);
      depth = Math.max(0, depth + opens - closes);
    }
  }
  return out.join('\n').trim();
}

export function skeletonizeWithAstOrLanguage(code: string, filePathOrLang = ''): string | null {
  const lower = filePathOrLang.toLowerCase();
  if (
    /\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(lower) ||
    ['ts', 'tsx', 'js', 'jsx', 'typescript', 'javascript'].includes(lower)
  ) {
    try {
      return skeletonizeTypeScriptAst(code, lower.startsWith('.') ? lower : `.${lower}`);
    } catch {
      return null;
    }
  }
  if (lower.endsWith('.rb') || lower === 'ruby' || lower === 'rb') return skeletonizeRuby(code);
  if (/\.(?:html|htm|xml|svg)$/.test(lower) || ['html', 'xml', 'svg'].includes(lower)) {
    return skeletonizeMarkup(code);
  }
  if (lower.endsWith('.sql') || lower === 'sql') return skeletonizeSql(code);
  if (/\.(?:yml|yaml)$/.test(lower) || lower === 'yaml' || lower === 'yml') return skeletonizeYaml(code);
  if (/\.(?:sh|bash|zsh)$/.test(lower) || ['sh', 'bash', 'zsh', 'shell'].includes(lower)) {
    return skeletonizeShell(code);
  }
  return null;
}
