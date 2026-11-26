export class ImportSlicer {
  /**
   * Extracts imported symbol names from the active editor file across TS/JS, Python, Go, and Rust.
   */
  public extractReferencedSymbols(activeFileCode: string): Set<string> {
    const symbols = new Set<string>();
    if (!activeFileCode) return symbols;

    // 1. JS/TS named imports: import { Foo, Bar as Baz } from '...'
    const namedImportRegex = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+['"][^'"]+['"]/g;
    let match: RegExpExecArray | null;
    while ((match = namedImportRegex.exec(activeFileCode)) !== null) {
      const inner = match[1];
      for (const part of inner.split(',')) {
        const cleaned = part.replace(/^\s*type\s+/, '').trim();
        const originalName = cleaned.split(/\s+as\s+/)[0]?.trim();
        if (originalName && /^[a-zA-Z0-9_$]+$/.test(originalName)) {
          symbols.add(originalName);
        }
      }
    }

    // 2. JS/TS default imports: import Foo from '...'
    const defaultImportRegex = /import\s+([a-zA-Z0-9_$]+)\s+from\s+['"][^'"]+['"]/g;
    while ((match = defaultImportRegex.exec(activeFileCode)) !== null) {
      if (match[1] !== 'type') symbols.add(match[1]);
    }

    // 3. Python imports: from module import a, b as c
    const pyFromImportRegex = /^\s*from\s+[a-zA-Z0-9_.]+\s+import\s+(.+)$/gm;
    while ((match = pyFromImportRegex.exec(activeFileCode)) !== null) {
      for (const part of match[1].split(',')) {
        const originalName = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (originalName && /^[a-zA-Z0-9_]+$/.test(originalName)) {
          symbols.add(originalName);
        }
      }
    }

    return symbols;
  }

  /**
   * Slices a dependency file down to ONLY the declarations matching `targetSymbols`
   * (plus imports), returning null if no target symbols are defined in this file.
   */
  public sliceToSymbols(
    dependencyCode: string,
    targetSymbols: Set<string>,
    filePathOrLang = ''
  ): string | null {
    if (targetSymbols.size === 0) return null;

    const lines = dependencyCode.split('\n');
    if (lines.length < 30) return null; // Too small to benefit from slicing

    const isPython = filePathOrLang.toLowerCase().endsWith('.py') || filePathOrLang === 'python';
    return isPython
      ? this.slicePythonSymbols(lines, targetSymbols)
      : this.sliceBraceSymbols(lines, targetSymbols);
  }

  private sliceBraceSymbols(lines: string[], targetSymbols: Set<string>): string | null {
    const keptChunks: string[] = [];
    const omittedNames: string[] = [];
    let matchedCount = 0;
    let i = 0;

    const declRegex =
      /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:declare\s+)?(?:async\s+)?(class|interface|type|enum|function|const|let|var|struct|trait|impl)\s+([a-zA-Z0-9_$]+)/;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Always retain top-level imports so types remain valid
      if (/^import\s+/.test(trimmed)) {
        keptChunks.push(line);
        i++;
        continue;
      }

      const declMatch = trimmed.match(declRegex);
      if (declMatch) {
        const symbolName = declMatch[2];
        const blockEnd = this.findBraceOrStatementEnd(lines, i);

        if (targetSymbols.has(symbolName)) {
          matchedCount++;
          // Include immediately preceding JSDoc comment if present
          const docStart = this.findPrecedingDocStart(lines, i);
          if (docStart < i) {
            keptChunks.push(...lines.slice(docStart, i));
          }
          keptChunks.push(...lines.slice(i, blockEnd + 1));
          keptChunks.push('');
        } else {
          omittedNames.push(symbolName);
        }
        i = blockEnd + 1;
        continue;
      }

      i++;
    }

    if (matchedCount === 0) return null;

    if (omittedNames.length > 0) {
      keptChunks.push(
        `// [Diet Toke 1-Hop Slice: omitted ${omittedNames.length} unreferenced symbols: ${omittedNames.slice(0, 12).join(', ')}]`
      );
    }

    return keptChunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private slicePythonSymbols(lines: string[], targetSymbols: Set<string>): string | null {
    const keptChunks: string[] = [];
    const omittedNames: string[] = [];
    let matchedCount = 0;
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (/^(import|from)\s+/.test(trimmed)) {
        keptChunks.push(line);
        i++;
        continue;
      }

      const pyDecl = trimmed.match(/^(?:async\s+)?(def|class)\s+([a-zA-Z0-9_]+)/);
      if (pyDecl && (line.match(/^\s*/)?.[0].length ?? 0) === 0) {
        const symbolName = pyDecl[2];
        let end = i + 1;
        while (end < lines.length) {
          const next = lines[end];
          if (next.trim() !== '' && (next.match(/^\s*/)?.[0].length ?? 0) === 0) break;
          end++;
        }

        if (targetSymbols.has(symbolName)) {
          matchedCount++;
          keptChunks.push(...lines.slice(i, end));
          keptChunks.push('');
        } else {
          omittedNames.push(symbolName);
        }
        i = end;
        continue;
      }

      i++;
    }

    if (matchedCount === 0) return null;

    if (omittedNames.length > 0) {
      keptChunks.push(
        `# [Diet Toke 1-Hop Slice: omitted ${omittedNames.length} unreferenced symbols: ${omittedNames.slice(0, 12).join(', ')}]`
      );
    }

    return keptChunks.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private findPrecedingDocStart(lines: string[], declLine: number): number {
    let idx = declLine - 1;
    while (idx >= 0 && lines[idx].trim() === '') idx--;
    if (idx >= 0 && lines[idx].trim().endsWith('*/')) {
      while (idx >= 0) {
        if (lines[idx].trim().startsWith('/**')) return idx;
        if (lines[idx].trim().startsWith('/*')) return declLine; // Non-JSDoc comment
        idx--;
      }
    }
    return declLine;
  }

  private findBraceOrStatementEnd(lines: string[], startLine: number): number {
    let depth = 0;
    let opened = false;

    for (let i = startLine; i < lines.length; i++) {
      const scrubbed = lines[i]
        .replace(/`(?:\\.|[^`\\])*`/g, '""')
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");

      const opens = (scrubbed.match(/\{/g) || []).length;
      const closes = (scrubbed.match(/\}/g) || []).length;
      if (opens > 0) opened = true;
      depth += opens - closes;

      if (opened && depth <= 0) return i;
      if (!opened && scrubbed.trim().endsWith(';')) return i;
    }

    return lines.length - 1;
  }
}