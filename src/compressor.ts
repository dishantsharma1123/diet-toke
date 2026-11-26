import { skeletonizeWithAstOrLanguage } from './astSkeletonizer';
import { compressGeminiPayload } from './geminiCompressor';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ImportSlicer } from './importSlicer';

export interface RequestLogEntry {
  timestamp: string;
  source: string;
  model?: string;
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  costSavedUsd?: number;
  providerInputTokens?: number;
  providerCachedTokens?: number;
  isLocal?: boolean;
}

export interface LifetimeStats {
  requestsProcessed: number;
  originalTokens: number;
  compressedTokens: number;
  cacheEligibleTokens: number;
  costSavedUsd?: number;
  providerInputTokens?: number;
  providerCachedTokens?: number;
}

export interface CompressionStats {
  requestsProcessed: number;
  originalTokens: number;
  compressedTokens: number;
  cacheEligibleTokens: number;
  costSavedUsd: number;
  providerInputTokens: number;
  providerCachedTokens: number;
  lastModel?: string;
  lastProviderLocal?: boolean;
  savedByLayer: {
    slicingAndSkeleton: number;
    toolPruning: number;
    logDistillation: number;
    historyAndDedup: number;
  };
  recentRequests: RequestLogEntry[];
  lifetime: LifetimeStats;
}

export interface CompressOptions {
  enabled: boolean;
  pruneTools: boolean;
  injectPromptCache: boolean;
  activeFileBasename?: string;
  activeFileCode?: string;
  workspaceRoot?: string;
  upstreamHostname?: string;
  upstreamPort?: number;
  requestModel?: string;
}

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.turbo',
  'coverage',
  '.venv',
  '__pycache__',
  '.vscode-test'
]);


function isAllowedWorkspaceEntry(name: string, isDirectory: boolean): boolean {
  if (IGNORED_DIRS.has(name)) return false;
  if (!name.startsWith(".")) return true;
  if (/^\.env(?:\.|$)/i.test(name) || /\.(?:pem|key|p12|pfx)$/i.test(name) || name === ".DS_Store") return false;
  if (isDirectory) return new Set([".github", ".gitlab", ".circleci", ".vscode", ".devcontainer", ".husky", ".cursor", ".cline"]).has(name);
  return /^\.(?:eslintrc|prettierrc|babelrc|stylelintrc|swcrc)/i.test(name) ||
    new Set([".editorconfig", ".gitignore", ".gitattributes", ".dockerignore", ".npmrc", ".nvmrc", ".node-version", ".python-version", ".tool-versions", ".flake8", ".pylintrc", ".rubocop.yml", ".golangci.yml"]).has(name);
}

export class TokenCompressor {
  private readonly slicer = new ImportSlicer();
  private seenBlockHashes = new Map<string, number>();

  public stats: CompressionStats = {
    requestsProcessed: 0,
    originalTokens: 0,
    compressedTokens: 0,
    cacheEligibleTokens: 0,
    costSavedUsd: 0,
    providerInputTokens: 0,
    providerCachedTokens: 0,
    savedByLayer: {
      slicingAndSkeleton: 0,
      toolPruning: 0,
      logDistillation: 0,
      historyAndDedup: 0
    },
    recentRequests: [],
    lifetime: {
      requestsProcessed: 0,
      originalTokens: 0,
      compressedTokens: 0,
      cacheEligibleTokens: 0,
      costSavedUsd: 0,
      providerInputTokens: 0,
      providerCachedTokens: 0
    }
  };

  public loadLifetimeStats(saved?: Partial<LifetimeStats>): void {
    if (!saved) return;
    this.stats.lifetime = {
      requestsProcessed: saved.requestsProcessed ?? 0,
      originalTokens: saved.originalTokens ?? 0,
      compressedTokens: saved.compressedTokens ?? 0,
      cacheEligibleTokens: saved.cacheEligibleTokens ?? 0,
      costSavedUsd: saved.costSavedUsd ?? 0,
      providerInputTokens: saved.providerInputTokens ?? 0,
      providerCachedTokens: saved.providerCachedTokens ?? 0
    };
  }

  public resetCache(): void {
    this.seenBlockHashes.clear();
  }

  public resetStats(): void {
    const preservedLifetime = { ...this.stats.lifetime };
    this.stats = {
      requestsProcessed: 0,
      originalTokens: 0,
      compressedTokens: 0,
      cacheEligibleTokens: 0,
      costSavedUsd: 0,
      providerInputTokens: 0,
      providerCachedTokens: 0,
      savedByLayer: {
        slicingAndSkeleton: 0,
        toolPruning: 0,
        logDistillation: 0,
        historyAndDedup: 0
      },
      recentRequests: [],
      lifetime: preservedLifetime
    };
  }

  public resetLifetimeStats(): void {
    this.stats.lifetime = {
      requestsProcessed: 0,
      originalTokens: 0,
      compressedTokens: 0,
      cacheEligibleTokens: 0,
      costSavedUsd: 0,
      providerInputTokens: 0,
      providerCachedTokens: 0
    };
  }

  public computeModelRates(model?: string, hostname?: string, port?: number): {
    inputPerMillion: number;
    cacheDiscountPerMillion: number;
    isLocal: boolean;
    label: string;
  } {
    const m = (model ?? "").trim();
    const lower = m.toLowerCase();
    const host = (hostname ?? "").toLowerCase();
    const isLocal =
      host === "127.0.0.1" ||
      host === "localhost" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      port === 11434 ||
      port === 1234 ||
      lower.startsWith("ollama/") ||
      lower.startsWith("local/");

    const label = m || (isLocal ? "local-model" : "unknown");
    if (isLocal) {
      return { inputPerMillion: 0, cacheDiscountPerMillion: 0, isLocal: true, label };
    }
    if (/claude-.*opus/i.test(lower)) return { inputPerMillion: 15.0, cacheDiscountPerMillion: 13.5, isLocal: false, label };
    if (/claude-.*haiku-4|claude-3-5-haiku/i.test(lower)) return { inputPerMillion: 0.8, cacheDiscountPerMillion: 0.72, isLocal: false, label };
    if (/claude-3-haiku/i.test(lower)) return { inputPerMillion: 0.25, cacheDiscountPerMillion: 0.225, isLocal: false, label };
    if (/claude-/i.test(lower)) return { inputPerMillion: 3.0, cacheDiscountPerMillion: 2.7, isLocal: false, label };
    if (/gemini-.*pro/i.test(lower)) return { inputPerMillion: 1.25, cacheDiscountPerMillion: 0.9375, isLocal: false, label };
    if (/gemini-.*flash-lite/i.test(lower)) return { inputPerMillion: 0.075, cacheDiscountPerMillion: 0.056, isLocal: false, label };
    if (/gemini-.*flash/i.test(lower)) return { inputPerMillion: 0.15, cacheDiscountPerMillion: 0.1125, isLocal: false, label };
    if (/gpt-4.1-nano/i.test(lower)) return { inputPerMillion: 0.1, cacheDiscountPerMillion: 0.05, isLocal: false, label };
    if (/gpt-4o-mini|gpt-4.1-mini|o4-mini|o3-mini|o1-mini/i.test(lower)) return { inputPerMillion: 0.15, cacheDiscountPerMillion: 0.075, isLocal: false, label };
    if (/gpt-4.1/i.test(lower)) return { inputPerMillion: 2.0, cacheDiscountPerMillion: 1.5, isLocal: false, label };
    if (/gpt-5/i.test(lower)) return { inputPerMillion: 1.25, cacheDiscountPerMillion: 1.125, isLocal: false, label };
    if (/gpt-4o|o3|o1/i.test(lower)) return { inputPerMillion: 2.5, cacheDiscountPerMillion: 1.25, isLocal: false, label };
    if (/deepseek-reasoner|deepseek-r1/i.test(lower)) return { inputPerMillion: 0.55, cacheDiscountPerMillion: 0.41, isLocal: false, label };
    if (/deepseek/i.test(lower)) return { inputPerMillion: 0.27, cacheDiscountPerMillion: 0.2, isLocal: false, label };
    return { inputPerMillion: 3.0, cacheDiscountPerMillion: 2.7, isLocal: false, label };
  }

  public recordProviderUsage(usage: { inputTokens?: number; cachedTokens?: number }): void {
    const inTok = Math.max(0, Math.round(usage.inputTokens ?? 0));
    const cacheTok = Math.max(0, Math.round(usage.cachedTokens ?? 0));
    if (inTok === 0 && cacheTok === 0) return;

    this.stats.providerInputTokens += inTok;
    this.stats.providerCachedTokens += cacheTok;
    this.stats.lifetime.providerInputTokens = (this.stats.lifetime.providerInputTokens ?? 0) + inTok;
    this.stats.lifetime.providerCachedTokens = (this.stats.lifetime.providerCachedTokens ?? 0) + cacheTok;

    const latest = this.stats.recentRequests[this.stats.recentRequests.length - 1];
    if (latest) {
      latest.providerInputTokens = inTok;
      latest.providerCachedTokens = cacheTok;
    }
  }

  public estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 3.7);
  }

  public compressDependencyCode(
    code: string,
    filePathOrLang = '',
    activeSymbols?: Set<string>,
    preserveCallSites = false
  ): string {
    if (preserveCallSites && activeSymbols && activeSymbols.size > 0) {
      const focused = this.sliceToRelevantWindows(code, activeSymbols, 4);
      if (focused.length < code.length * 0.65) {
        return focused;
      }
    }

    let working = code;
    if (activeSymbols && activeSymbols.size > 0) {
      const sliced = this.slicer.sliceToSymbols(code, activeSymbols, filePathOrLang);
      if (sliced) {
        working = sliced;
      }
    }

    const skeleton = this.skeletonizeCode(working, filePathOrLang);

    if (skeleton.length > 1400 && activeSymbols && activeSymbols.size > 0) {
      const focused = this.sliceToRelevantWindows(working, activeSymbols, 6);
      if (focused.length < skeleton.length) {
        return focused;
      }
    }

    return skeleton;
  }

  private sliceToRelevantWindows(
    code: string,
    symbols: Set<string>,
    contextLines = 6
  ): string {
    const lines = code.split('\n');
    if (lines.length <= contextLines * 3) return code;

    const keep = new Array<boolean>(lines.length).fill(false);
    const escaped = Array.from(symbols)
      .filter((s) => s.length >= 3)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const symRegex = escaped.length > 0 ? new RegExp(`\\b(?:${escaped.join('|')})\\b`) : null;

    let hitCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^(import|export|interface|type|enum|class)\b/.test(t)) {
        keep[i] = true;
      }
      if (symRegex && symRegex.test(lines[i])) {
        hitCount++;
        const start = Math.max(0, i - contextLines);
        const end = Math.min(lines.length - 1, i + contextLines);
        for (let j = start; j <= end; j++) {
          keep[j] = true;
        }
      }
    }

    if (hitCount === 0) {
      return this.skeletonizeCode(code);
    }

    const out: string[] = [];
    let omitted = 0;
    for (let i = 0; i < lines.length; i++) {
      if (keep[i]) {
        if (omitted > 0) {
          out.push(`// ... [${omitted} lines omitted] ...`);
          omitted = 0;
        }
        out.push(lines[i]);
      } else {
        omitted++;
      }
    }
    if (omitted > 0) {
      out.push(`// ... [${omitted} lines omitted] ...`);
    }

    const result = out.join('\n').trim();
    return result.length > 80 ? result : code;
  }

  public skeletonizeCode(code: string, filePathOrLang = ''): string {
    const astOrLangResult = skeletonizeWithAstOrLanguage(code, filePathOrLang);
    if (astOrLangResult !== null) return astOrLangResult;
    const ext = filePathOrLang.toLowerCase();
    if (ext.endsWith('.py') || ext === 'python') {
      return this.skeletonizePython(code);
    }
    if (ext.endsWith('.json') || ext === 'json' || ext.endsWith('.md') || ext === 'markdown') {
      return code.replace(/\n{3,}/g, '\n\n').trim();
    }
    return this.skeletonizeBraceLanguage(code);
  }

  private skeletonizeBraceLanguage(code: string): string {
    let cleaned = code.replace(/\/\*[\s\S]*?\*\//g, (match) => {
      if (!match.startsWith('/**')) return '';
      const summary = match
        .replace(/^\/\*\*|\*\/$/g, '')
        .split('\n')
        .map((l) => l.replace(/^\s*\*\s?/, '').trim())
        .find((l) => l.length > 0 && !l.startsWith('@'));
      return summary ? `/** ${summary} */` : '';
    });
    cleaned = cleaned.replace(/(^|[^:\\])\/\/(?!\/).*$/gm, '$1');

    const lines = cleaned.split('\n');
    const output: string[] = [];
    let braceDepth = 0;
    let bodyStartDepth: number | null = null;
    let omitEntireMember = false;

    const containerRegex =
      /^\s*(export\s+)?(default\s+)?(abstract\s+)?(declare\s+)?(class|interface|struct|enum|namespace|module|trait|impl|type)\b/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        if (bodyStartDepth === null && output[output.length - 1] !== '') {
          output.push('');
        }
        continue;
      }

      const scrubbed = trimmed
        .replace(/`(?:\\.|[^`\\])*`/g, '""')
        .replace(/"(?:\\.|[^"\\])*"/g, '""')
        .replace(/'(?:\\.|[^'\\])*'/g, "''");

      const openCount = (scrubbed.match(/\{/g) || []).length;
      const closeCount = (scrubbed.match(/\}/g) || []).length;

      if (bodyStartDepth !== null) {
        braceDepth += openCount - closeCount;
        if (braceDepth <= bodyStartDepth) {
          if (!omitEntireMember && output.length > 0) {
            output[output.length - 1] = `${output[output.length - 1]} ... }`;
          }
          bodyStartDepth = null;
          omitEntireMember = false;
        }
        continue;
      }

      const isContainer = containerRegex.test(trimmed);
      const looksLikeCallable =
        !isContainer &&
        /\)\s*(?::\s*[^=]+?)?\s*(?:=>\s*)?\{$/.test(trimmed) &&
        !/^(if|for|while|switch|catch|else)\b/.test(trimmed);

      if (looksLikeCallable && openCount > closeCount) {
        let sigStart = output.length;
        while (
          sigStart > 0 &&
          sigStart > output.length - 8 &&
          output[sigStart - 1].trim() !== '' &&
          !/[;{}]$|\*\/$/.test(output[sigStart - 1].trim())
        ) {
          sigStart--;
        }

        const sigLines = [...output.slice(sigStart), line];
        const indent = sigLines[0].match(/^\s*/)?.[0] ?? '';
        const mergedSig = `${indent}${sigLines.map((s) => s.trim()).join(' ')}`;
        output.length = sigStart;

        if (braceDepth >= 1 && mergedSig.trimStart().startsWith('private ')) {
          if (output.length > 0 && output[output.length - 1].trim().startsWith('/**')) {
            output.pop();
          }
          omitEntireMember = true;
        } else {
          output.push(mergedSig);
          omitEntireMember = false;
        }

        bodyStartDepth = braceDepth;
        braceDepth += openCount - closeCount;
      } else {
        output.push(line);
        braceDepth = Math.max(0, braceDepth + openCount - closeCount);
      }
    }

    return output
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((l) => l.replace(/^( {2,})/, (_, s: string) => ' '.repeat(Math.ceil(s.length / 2))))
      .join('\n')
      .trim();
  }

  private skeletonizePython(code: string): string {
    const lines = code.split('\n');
    const output: string[] = [];
    let skippingIndent: number | null = null;
    let inDocstring = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      const indent = line.match(/^\s*/)?.[0].length ?? 0;

      if (!trimmed) {
        if (skippingIndent === null) output.push('');
        continue;
      }

      if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
        const quote = trimmed.slice(0, 3);
        const isSingleLine = trimmed.length > 3 && trimmed.endsWith(quote);
        if (skippingIndent !== null && indent > skippingIndent) {
          output.push(line);
          if (!isSingleLine) inDocstring = !inDocstring;
          continue;
        }
      }

      if (inDocstring) {
        output.push(line);
        if (trimmed.endsWith('"""') || trimmed.endsWith("'''")) {
          inDocstring = false;
        }
        continue;
      }

      if (skippingIndent !== null) {
        if (indent > skippingIndent) continue;
        skippingIndent = null;
      }

      if (trimmed.startsWith('#')) continue;
      output.push(line);

      if (/^(async\s+)?def\s+[a-zA-Z0-9_]+\s*\(.*\)\s*(->.*)?:\s*$/.test(trimmed)) {
        skippingIndent = indent;
        output.push(`${' '.repeat(indent + 4)}...`);
      }
    }

    return output.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private compactSchemaProps(schema: unknown): unknown {
    if (!schema || typeof schema !== "object") return schema;
    const s = schema as Record<string, unknown>;
    if (!s.properties || typeof s.properties !== "object") return schema;
    const nextProps: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
      if (v && typeof v === "object") {
        const prop = { ...(v as Record<string, unknown>) };
        if (typeof prop.description === "string" && prop.description.length > 65) {
          prop.description = prop.description.split(/[.\\n]/)[0].slice(0, 65).trim();
        }
        nextProps[k] = prop;
      } else {
        nextProps[k] = v;
      }
    }
    return { ...s, properties: nextProps };
  }


  private pruneUnusedTools(
    tools: Array<Record<string, unknown>>,
    latestUserPrompt: string
  ): Array<Record<string, unknown>> {
    if (!Array.isArray(tools) || tools.length === 0) return tools;

    const intent = this.classifyPromptIntent(latestUserPrompt);
    const editAllowed = intent !== "read-only";
    const execAllowed = this.needsCommandExecution(latestUserPrompt, intent);
    const keywords = new Set(latestUserPrompt.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2));

    const coreReadOrMcpRegex = /(read|file|search|grep|find|list|dir|tree|symbol|definition|mcp|diet_|ask|attempt|complet|view|inspect)/i;
    const editRegex = /(edit|write|replace|patch|apply|insert|create|modify|update|delete|remove)/i;
    const execRegex = /(exec|command|bash|shell|terminal|run)/i;

    const filtered = tools.filter((tool) => {
      const fn = (tool.function as Record<string, unknown>) ?? tool;
      const name = String(fn.name ?? "");
      if (!name) return true;
      if (editRegex.test(name)) return editAllowed;
      if (execRegex.test(name)) return execAllowed;
      if (coreReadOrMcpRegex.test(name)) return true;
      for (const word of keywords) {
        if (word.length >= 4 && name.toLowerCase().includes(word)) return true;
      }
      return false;
    });

    const effectiveTools = filtered.length > 0 ? filtered : tools;

    return effectiveTools.map((tool) => {
      const fn = tool.function as Record<string, unknown> | undefined;
      if (!fn || typeof fn !== "object") {
        const shortDesc = typeof tool.description === "string" ? tool.description.split(/[.\\n]/)[0].slice(0, 120) : "";
        return {
          ...tool,
          description: shortDesc,
          ...(tool.input_schema ? { input_schema: this.compactSchemaProps(tool.input_schema) } : {})
        };
      }
      const shortDesc = typeof fn.description === "string" ? fn.description.split(/[.\\n]/)[0].slice(0, 140) : "";
      return {
        ...tool,
        function: {
          ...fn,
          description: shortDesc,
          ...(fn.parameters ? { parameters: this.compactSchemaProps(fn.parameters) } : {})
        }
      };
    });
  }

  private distillToolOutput(output: string): string {
    if (output.length < 1000) return output;

    const clean = output.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
    const lines = clean.split('\n');

    const isLog =
      /(PASS|FAIL|Error:|ERR!|warning TS|at\s+.*:\d+:\d+|npm\s+ERR|pytest|cargo\s+test|Traceback)/i.test(
        clean
      );
    if (!isLog) return clean;

    const signalLines = lines.filter((line) => {
      const t = line.trim();
      if (!t) return false;
      if (t.startsWith('at ') && t.includes('node_modules')) return false;
      return /(FAIL|ERROR|ERR!|Exception|AssertionError|Expected:|Received:|warning TS\d+|error TS\d+|:\d+:\d+|Tests:|Snapshots:|File ".*", line \d+)/i.test(
        t
      );
    });

    if (signalLines.length === 0) {
      return [
        ...lines.slice(0, 12),
        `... [${Math.max(0, lines.length - 24)} log lines omitted] ...`,
        ...lines.slice(-12)
      ].join('\n');
    }

    return (
      `[Diet Toke Log Distill: ${lines.length} lines -> ${signalLines.length} signal lines]\n` +
      signalLines.slice(0, 80).join('\n')
    );
  }

  private isToolResultUserMessage(cleanedText: string): boolean {
    const t = cleanedText.trim();
    if (!t) return true;
    return (
      /^\[[a-z0-9_ -]+(?:\s+for\s+['"][^'"]+['"])?\]\s*Result:/i.test(t) ||
      /^\/\/ Resolved path:/i.test(t) ||
      /^<(?:file_content|file|search_results|command_output)\b/i.test(t) ||
      /^\[Diet Toke:/i.test(t) ||
      (t.startsWith('{') && t.includes('"// Resolved path:'))
    );
  }

  private extractLatestUserText(messages: unknown[]): string {
    let fallbackTask = '';

    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string; content?: unknown } | undefined;
      if (m?.role !== 'user') continue;

      let raw = '';
      if (typeof m.content === 'string') {
        raw = m.content;
      } else if (Array.isArray(m.content)) {
        raw = m.content
          .map((p: Record<string, unknown>) => (typeof p?.text === 'string' ? p.text : ''))
          .join('\n');
      }

      const taskMatch = raw.match(/<task>([\s\S]*?)<\/task>/i);
      if (taskMatch) return taskMatch[1].trim();

      const withoutEnv = raw
        .replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '')
        .trim();
      if (!withoutEnv || this.isToolResultUserMessage(withoutEnv)) {
        continue;
      }

      if (!fallbackTask) {
        fallbackTask = withoutEnv;
      }
    }

    return fallbackTask;
  }

  private extractVisibleBasenames(messages: unknown[], fallbackBasename?: string): Set<string> {
    const names = new Set<string>();
    if (fallbackBasename) {
      names.add(fallbackBasename);
    }

    for (const rawMsg of messages) {
      const m = rawMsg as { content?: unknown } | undefined;
      let text = '';
      if (typeof m?.content === 'string') {
        text = m.content;
      } else if (Array.isArray(m?.content)) {
        text = m.content
          .map((p: Record<string, unknown>) => (typeof p?.text === 'string' ? p.text : ''))
          .join('\n');
      }

      const envBlocks = text.match(/<environment_details>[\s\S]*?<\/environment_details>/gi) || [];
      for (const block of envBlocks) {
        const visibleSection =
          block.match(/# VSCode (?:Visible Files|Open Tabs)\n([\s\S]*?)(?=\n# |$)/g) || [];
        for (const sec of visibleSection) {
          for (const line of sec.split('\n').slice(1)) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('(')) {
              names.add(path.basename(trimmed));
            }
          }
        }
      }
    }

    return names;
  }

  private classifyPromptIntent(prompt: string): 'read-only' | 'edit' | 'ambiguous' {
    const trimmed = prompt.trim();
    if (!trimmed) return 'ambiguous';

    // 1. Global read-only / no-file-edit prohibitions (always read-only)
    const globalReadOnlyLatin =
      /\bread[- ]only\b|\b(do not|don't|dont|never|no|avoid)\s+(edit|edits|make\s+any\s+(?:edits|changes|modifications)|(?:modify|change|touch|write\s+to)\s+any\s+files?)\b|\bwithout\s+(?:editing|modifying|changing|touching)\s+(?:any\s+)?files?\b|\b(just|only)\s+(read|explain|check|inspect|review|analyze|summarize|describe|show|tell|list|find|locate|trace)\b|\b(edit|change|modify)\s+mat\s+kar(o|na)\b|\bmat\s+badl(o|a)\b|\bsirf\s+(batao|samjhao|dekho)\b|\b(no\s+edites|no\s+modifiques|sin\s+editar|sin\s+modificar|solo\s+explica)\b|\b(ne\s+modifie\s+pas|n'édite\s+pas|sans\s+modifier|explique\s+seulement)\b|\b(nicht\s+bearbeiten|nicht\s+ändern|ohne\s+zu\s+ändern|nur\s+erklären)\b|\b(não\s+edite|não\s+modifique|sem\s+editar|apenas\s+explique)\b/i;
    const globalReadOnlyNonLatin =
      /(एडिट\s*मत\s*कर|बदलाव\s*मत\s*कर|सिर्फ\s*(?:बता|समझा)|編集しないで|変更しないで|書き換えないで|不要修改|不要编辑|别改|只解释|수정하지\s*마|편집하지\s*마|변경하지\s*말고|не\s+редактируй|не\s+изменяй|без\s+изменений)/i;

    if (globalReadOnlyLatin.test(trimmed) || globalReadOnlyNonLatin.test(trimmed)) {
      return 'read-only';
    }

    // 2. Direct & indirect edit/mutation verbs and idioms (takes priority over scoped "without changing X" constraints)
    const editActionLatin =
      /\b(edit|fix|fixes|fixed|fixing|add|adds|added|adding|update|updates|updated|updating|refactor|refactors|refactored|refactoring|implement|implements|implemented|implementing|change|changes|changed|changing|delete|deletes|deleted|deleting|remove|removes|removed|removing|write|writes|wrote|writing|create|creates|created|creating|modify|modifies|modified|modifying|patch|patches|patched|patching|rewrite|rewrites|rewrote|rename|renames|renamed|replace|replaces|replaced|insert|inserts|inserted|append|prepend|extract|inline|split|merge|move|wrap|migrate|upgrade|bump|scaffold|generate|stub|convert|port|handle|support|enable|disable|toggle|guard|validate|sanitize|normalize|format|lint|optimize|simplify|tidy|tighten|tightening|shorten|condense|bug|broken|crash|hotfix|workaround)\b|\bclean\s+(?:this\s+|it\s+|that\s+|the\s+code\s+)?up\b|\b(wire|hook|set|spin|bring)\s+(?:this\s+|it\s+)?up\b|\b(fix|edit|change|add|update|remove|delete|create|refactor|saaf)\s+kar(o|na|de|do)\b|\b(banao|sudharo|badlo|hatao|jodo)\b|\b(edita|modifica|cambia|arregla|corrige|añade|agrega|elimina|borra|crea|refactoriza|limpia|actualiza|adiciona|corrija)\b|\b(modifie|édite|corrige|répare|ajoute|supprime|crée|refactorise|nettoie|mets\s+à\s+jour)\b|\b(bearbeite|ändere|fixe|repariere|füge\s+hinzu|entferne|lösche|erstelle|bereinige|aktualisiere)\b/i;
    const editActionNonLatin =
      /(ठीक\s*कर|बदलो|जोड़ो|हटाओ|बनाओ|फिक्स|बग|修正|編集|変更|追加|削除|作成|リファクタ|直して|書き換えて|実装|修改|编辑|修复|添加|新增|删除|创建|重构|实现|改一下|清理|수정|편집|고쳐|추가|삭제|생성|리팩토링|구현|바꿔|исправь|отредактируй|измени|добавь|удали|создай|рефактори)/i;

    if (editActionLatin.test(trimmed) || editActionNonLatin.test(trimmed)) {
      return 'edit';
    }

    // 3. Scoped no-edit constraint with no edit action present
    if (
      /\b(do not|don't|dont|without|never|no|avoid)\s+(edit|modify|change|write|touch|alter|update|patch|refactor)\b/i.test(
        trimmed
      )
    ) {
      return 'read-only';
    }

    // 4. Pure inquiry / inspection verbs across languages
    const readOnlyInquiryLatin =
      /\b(explain|describe|summarize|summary|what\s+does|what\s+is|what\s+are|how\s+does|how\s+do|how\s+is|why\s+does|why\s+is|where\s+is|where\s+are|find|locate|trace|inspect|audit|review|check\s+how|show\s+me|list|compare|walk\s+me\s+through|tell\s+me|understand|overview|architecture)\b|\b(kya\s+karta|kaise\s+kaam|samjhao|batao|dikhao)\b|\b(explica|qué\s+hace|cómo\s+funciona|como\s+funciona|explique|comment\s+fonctionne|erkläre|was\s+macht|wie\s+funktioniert)\b/i;
    const readOnlyInquiryNonLatin =
      /(कैसे\s*काम|क्या\s*करता|समझाओ|बताओ|とは|仕組み|説明|教えて|確認して|为什么|怎么工作|做什么|解释|分析一下|무엇|어떻게|설명|알려줘|объясни|как\s+работает)/i;

    if (readOnlyInquiryLatin.test(trimmed) || readOnlyInquiryNonLatin.test(trimmed)) {
      return 'read-only';
    }

    return 'ambiguous';
  }

  private isEditIntent(prompt: string): boolean {
    return this.classifyPromptIntent(prompt) !== 'read-only';
  }

  private needsCommandExecution(
    prompt: string,
    intent: 'read-only' | 'edit' | 'ambiguous'
  ): boolean {
    // Keep execution tools on edit or ambiguous prompts so indirect tasks never stall on turn 1
    if (intent !== 'read-only') return true;

    // Even in read-only mode, retain execution tools if the user asks to verify/check/test/build
    const verifyOrRunLatin =
      /\b(test|tests|testing|run|running|build|builds|building|compile|compiling|tsc|typecheck|lint|linter|verify|verifying|validate|diagnose|diagnostic|diagnostics|status|health|npm|pnpm|yarn|bun|pytest|cargo|go\s+test|command|terminal|shell|cli|error|errors|failing|execute)\b/i;
    const verifyOrRunNonLatin =
      /(टेस्ट|बिल्ड|रन|चलाओ|テスト|ビルド|実行|测试|构建|编译|运行|테스트|빌드|실행|тест|сборк|запусти)/i;

    return verifyOrRunLatin.test(prompt) || verifyOrRunNonLatin.test(prompt);
  }

  private extractPromptIdentifiers(prompt: string): Set<string> {
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was',
      'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they', 'their', 'what', 'when',
      'where', 'who', 'will', 'with', 'how', 'why', 'any', 'from', 'into', 'than', 'then',
      'them', 'these', 'this', 'that', 'read', 'check', 'reply', 'short', 'bullet', 'points',
      'under', 'words', 'total', 'edit', 'file', 'files', 'code', 'function', 'called', 'using'
    ]);
    const ids = new Set<string>();
    const matches = prompt.match(/\b[A-Za-z_][A-Za-z0-9_]{2,}\b/g) || [];
    for (const m of matches) {
      if (!stopWords.has(m.toLowerCase())) {
        ids.add(m);
      }
    }
    return ids;
  }

  private distillSystemPrompt(
    content: string,
    latestUserPrompt: string,
    hasNativeTools = false
  ): string {
    const parts: string[] = [
      'You are an expert software engineer. Use tools to inspect and edit files accurately. Always use workspace-relative paths listed in <environment_details> files= (e.g., frontend/src/lib/storage.ts). If a file path is not listed in <environment_details>, call `diet_workspace_map`, `search_files`, or `list_files` to locate it before answering.'
    ];

    if (!hasNativeTools) {
      const toolBlocks = content.match(
        /^#{2,3}\s+[a-z0-9_]+[\s\S]*?(?=^#{2,3}\s+|^====|^#\s+[A-Z]{4,}|$)/gm
      );
      if (!toolBlocks || toolBlocks.length === 0) {
        return content;
      }

      if (content.includes('<tool_name>') || content.includes('TOOL USE')) {
        parts.push(
          'Call one XML tool per turn and wait for result:\n<read_file><path>relative/path</path></read_file>'
        );
      }

      const intent = this.classifyPromptIntent(latestUserPrompt);
      const editAllowed = intent !== 'read-only';
      const execAllowed = this.needsCommandExecution(latestUserPrompt, intent);
      const editRegex = /(edit|write|replace|patch|apply)/i;
      const keptSpecs: string[] = [];

      for (const block of toolBlocks) {
        const nameMatch = block.match(/^#{2,3}\s+([a-z0-9_]+)/);
        if (!nameMatch) continue;
        const toolName = nameMatch[1];

        if (editRegex.test(toolName) && !editAllowed) continue;
        if (toolName === 'execute_command' && !execAllowed) continue;
        if (toolName === 'browser_action' || toolName === 'new_task') continue;

        const params = Array.from(block.matchAll(/^-\s+([a-z0-9_]+)\s*:/gm))
          .map((m) => m[1])
          .join(', ');
        keptSpecs.push(`- ${toolName}(${params})`);
      }

      if (keptSpecs.length === 0) {
        return content;
      }
      parts.push('Tools:\n' + keptSpecs.join('\n'));

      if (content.includes('diet-toke')) {
        parts.push(
          'MCP `diet-toke`: diet_workspace_map, diet_read_relevant, diet_read_skeleton, diet_read_full_file.'
        );
      }
    }

    const cwdMatch = content.match(/Current Working Directory:\s*([^\n]+)/i);
    if (cwdMatch) {
      parts.push(`CWD: ${cwdMatch[1].trim()}`);
    }

    const distilled = parts.join('\n\n').trim();
    return distilled.length < content.length ? distilled : content;
  }

  private expandHome(p: string): string {
    if (!p) return '';
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
  }

  /**
   * Scans the entire repository for files matching prompt tokens without bailing out early
   * on unrelated subdirectories (e.g. backend/ vs frontend/).
   */
  private findMatchingFiles(workspaceRoot: string, promptTokens: Set<string>): string[] {
    if (promptTokens.size === 0 || !fs.existsSync(workspaceRoot)) return [];

    const matches: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 8 || matches.length >= 15) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (matches.length >= 15) break;
        if (entry.isDirectory()) {
          if (isAllowedWorkspaceEntry(entry.name, true)) {
            walk(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const base = entry.name.toLowerCase();
          const stem = base.replace(/\.[^.]+$/, '');
          if (promptTokens.has(base) || promptTokens.has(stem)) {
            matches.push(path.relative(workspaceRoot, path.join(dir, entry.name)).replace(/\\/g, '/'));
          }
        }
      }
    };

    walk(workspaceRoot, 0);
    return matches;
  }

  /**
   * Collects breadth-first top-level directories and files so monorepo roots (backend/, frontend/)
   * are always visible even when one subtree has hundreds of files.
   */
  private collectBreadthFirstFiles(workspaceRoot: string, maxEntries = 35): string[] {
    if (!fs.existsSync(workspaceRoot)) return [];

    const results: string[] = [];
    const queue: Array<{ dir: string; depth: number }> = [{ dir: workspaceRoot, depth: 0 }];

    while (queue.length > 0 && results.length < maxEntries) {
      const current = queue.shift()!;
      if (current.depth > 4) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (results.length >= maxEntries) break;
        if (!isAllowedWorkspaceEntry(entry.name, entry.isDirectory())) continue;

        const full = path.join(current.dir, entry.name);
        const rel = path.relative(workspaceRoot, full).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          results.push(`${rel}/`);
          queue.push({ dir: full, depth: current.depth + 1 });
        } else if (entry.isFile()) {
          results.push(rel);
        }
      }
    }

    return results;
  }

  private compactEnvironmentDetails(
    text: string,
    isOldTurn: boolean,
    latestUserPrompt = '',
    fallbackWorkspaceRoot?: string
  ): string {
    return text.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, (block) => {
      if (isOldTurn) return '';

      const visibleLines = (
        block.match(/# VSCode (?:Visible Files|Open Tabs)\n([\s\S]*?)(?=\n# |$)/g) || []
      )
        .flatMap((sec) => sec.split('\n').slice(1))
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !l.startsWith('('));

      const cwdMatch =
        block.match(/# Current Working Directory \(([^)]+)\)/) ||
        block.match(/# Current Working Directory[^\n]*\n([^\n#]+)/) ||
        block.match(/# Workspace Directory[^\n]*\n([^\n#]+)/);
      const rawCwd = cwdMatch?.[1]?.trim() || fallbackWorkspaceRoot || '';
      const resolvedCwd = this.expandHome(rawCwd);

      const promptTokens = new Set(latestUserPrompt.toLowerCase().match(/[a-z0-9_.-]{3,}/g) || []);
      const prioritizedFiles = new Set<string>(visibleLines);

      // 1. Always find exact filename/stem matches across the entire workspace first
      if (resolvedCwd) {
        for (const rel of this.findMatchingFiles(resolvedCwd, promptTokens)) {
          prioritizedFiles.add(rel);
        }
      }

      // 2. Include any paths already listed in Cline's <environment_details>
      for (const rawLine of block.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith('(') || line.endsWith('/')) continue;
        if (!/[./]/.test(line)) continue;
        prioritizedFiles.add(line);
      }

      // 3. Add breadth-first structure so all top-level folders (backend/, frontend/, src/) appear
      if (resolvedCwd) {
        for (const rel of this.collectBreadthFirstFiles(resolvedCwd, 60)) {
          prioritizedFiles.add(rel);
        }
      }

      const fileList = Array.from(prioritizedFiles).slice(0, 70);
      const summary = [
        rawCwd ? `cwd=${rawCwd}` : '',
        visibleLines.length > 0 ? `visible=${Array.from(new Set(visibleLines)).join(', ')}` : '',
        fileList.length > 0 ? `files=${fileList.join(', ')}` : ''
      ]
        .filter(Boolean)
        .join(' | ');

      return summary ? `<environment_details>${summary}</environment_details>` : '';
    });
  }

  public compressPromptText(
    text: string,
    activeBasenames?: Set<string>,
    dependencySymbols?: Set<string>,
    editingMode = true,
    promptSymbols?: Set<string>,
    seenInPayload?: Set<string>
  ): string {
    if (!text || text.length < 220) return text;
    const seenSet = seenInPayload ?? new Set<string>();

    let trailingEnv = "";
    let bodyText = text;
    const envTailMatch = bodyText.match(/(\s*<environment_details>[\s\S]*?<\/environment_details>\s*)$/i);
    if (envTailMatch) {
      trailingEnv = envTailMatch[1];
      bodyText = bodyText.slice(0, bodyText.length - trailingEnv.length);
    }

    const mcpEnvelopeMatch = bodyText.match(/^([\s\S]*?)(\{"content":\s*\[\s*\{[\s\S]*\}\s*\]\s*\})\s*$/);
    if (mcpEnvelopeMatch) {
      try {
        const parsed = JSON.parse(mcpEnvelopeMatch[2]) as { content?: Array<Record<string, unknown>> };
        if (Array.isArray(parsed?.content)) {
          let changed = false;
          const updatedContent = parsed.content.map((item) => {
            if (item?.type === "text" && typeof item.text === "string") {
              const compressedInner = this.compressPromptText(
                item.text, activeBasenames, dependencySymbols, editingMode, promptSymbols, seenSet
              );
              if (compressedInner !== item.text) {
                changed = true;
                return { ...item, text: compressedInner };
              }
            }
            return item;
          });
          if (changed) {
            return mcpEnvelopeMatch[1] + JSON.stringify({ ...parsed, content: updatedContent }) + trailingEnv;
          }
        }
      } catch {}
    }

    const compressFileBlock = (filePath: string, innerCode: string): string | null => {
      const base = path.basename(filePath);
      const isActiveFile = Boolean(activeBasenames && activeBasenames.has(base));
      if ((isActiveFile && editingMode) || innerCode.length < 220) return null;
      const strippedGutter = innerCode.replace(/^\s*\d+\s*\|\s?/gm, "");
      const targetSymbols = isActiveFile ? promptSymbols : dependencySymbols;
      const preserveCallSites = isActiveFile && !editingMode;
      return this.deduplicateOrTransform(
        strippedGutter,
        () => this.compressDependencyCode(strippedGutter, filePath, targetSymbols, preserveCallSites),
        seenSet
      );
    };

    let result = bodyText.replace(
      /<file_content\s+path="([^"]+)"[^>]*>\r?\n?([\s\S]*?)<\/file_content>/gi,
      (fullMatch, filePath: string, innerCode: string) => {
        const compacted = compressFileBlock(filePath, innerCode);
        return compacted === null
          ? fullMatch
          : `<file_content path="${filePath}">\n// [compressed by diet-toke]\n${compacted}\n</file_content>`;
      }
    );

    const headerRegex = new RegExp(
      "(^|\r?\n)(?:\/\/\s*(?:Resolved path|File)|File):\s*([^\s(\r\n]+)(?:[^\r\n]*)\r?\n([\s\S]*?)(?=\r?\n<(?:environment_details|\/[a-z_]+)>|$)",
      "gi"
    );
    result = result.replace(headerRegex, (fullMatch, prefix, filePath, innerCode) => {
      const compacted = compressFileBlock(filePath, innerCode);
      return compacted === null
        ? fullMatch
        : prefix + "// Resolved path: " + filePath + " [compressed by diet-toke]\n" + compacted;
    });

    if (!editingMode && result === bodyText && /^\s*1\s*\|/m.test(bodyText)) {
      const strippedGutter = bodyText.replace(/^\s*\d+\s*\|\s?/gm, "");
      if (strippedGutter.length >= 220) {
        result = this.deduplicateOrTransform(
          strippedGutter,
          () => this.compressDependencyCode(strippedGutter, ".ts", promptSymbols, true),
          seenSet
        );
      }
    }

    result = result.replace(/```([a-zA-Z0-9_.-]*)\n([\s\S]*?)```/g, (fullMatch, lang: string, code: string) => {
      if (code.length < 350) return fullMatch;
      if (editingMode && activeBasenames) {
        for (const b of activeBasenames) if (code.includes(b)) return fullMatch;
      }
      const deduped = this.deduplicateOrTransform(
        code, () => this.compressDependencyCode(code, lang, dependencySymbols), seenSet
      );
      return `\`\`\`${lang}\n${deduped}\n\`\`\``;
    });

    return result + trailingEnv;
  }

  private deduplicateOrTransform(
    content: string,
    transform: () => string,
    seenSet: Set<string>
  ): string {
    const hash = crypto.createHash('sha256').update(content.trim()).digest('hex').slice(0, 12);
    if (seenSet.has(hash)) {
      const firstLine = content.trim().split('\n')[0]?.slice(0, 80) ?? '';
      const stub = `/* [Diet Toke: Identical block #${hash} already in active context (${firstLine}...) ] */`;
      const saved = Math.max(0, this.estimateTokens(content) - this.estimateTokens(stub));
      this.stats.savedByLayer.historyAndDedup += saved;
      return stub;
    }

    seenSet.add(hash);
    return transform();
  }

  private applyPromptCaching(payload: Record<string, unknown>, isAnthropic: boolean): number {
    let eligibleTokens = 0;

    if (isAnthropic) {
      if (Array.isArray(payload.tools) && payload.tools.length > 0) {
        const lastTool = payload.tools[payload.tools.length - 1] as Record<string, unknown>;
        if (lastTool && typeof lastTool === "object" && !lastTool.cache_control) {
          lastTool.cache_control = { type: "ephemeral" };
        }
        eligibleTokens += this.estimateTokens(JSON.stringify(payload.tools));
      }
      if (typeof payload.system === 'string' && payload.system.length > 1000) {
        eligibleTokens += this.estimateTokens(payload.system);
        payload.system = [
          {
            type: 'text',
            text: payload.system,
            cache_control: { type: 'ephemeral' }
          }
        ];
      } else if (Array.isArray(payload.system) && payload.system.length > 0) {
        const lastSys = payload.system[payload.system.length - 1] as Record<string, unknown>;
        if (lastSys && typeof lastSys === 'object' && !lastSys.cache_control) {
          lastSys.cache_control = { type: 'ephemeral' };
        }
        eligibleTokens += this.estimateTokens(JSON.stringify(payload.system));
      }

      if (Array.isArray(payload.messages)) {
        if (payload.messages.length >= 3) {
          const targetMsg = payload.messages[payload.messages.length - 2] as Record<string, unknown>;
          if (typeof targetMsg.content === 'string' && targetMsg.content.length > 800) {
            targetMsg.content = [
              {
                type: 'text',
                text: targetMsg.content,
                cache_control: { type: 'ephemeral' }
              }
            ];
          } else if (Array.isArray(targetMsg.content) && targetMsg.content.length > 0) {
            const lastPart = targetMsg.content[targetMsg.content.length - 1] as Record<string, unknown>;
            if (lastPart && typeof lastPart === 'object') {
              lastPart.cache_control = { type: 'ephemeral' };
            }
          }
          eligibleTokens += this.estimateTokens(
            JSON.stringify(payload.messages.slice(0, payload.messages.length - 1))
          );
        } else if (payload.messages.length >= 1) {
          const firstMsg = payload.messages[0] as Record<string, unknown>;
          if (typeof firstMsg.content === 'string' && firstMsg.content.length > 1000) {
            eligibleTokens += this.estimateTokens(firstMsg.content);
            firstMsg.content = [
              {
                type: 'text',
                text: firstMsg.content,
                cache_control: { type: 'ephemeral' }
              }
            ];
          }
        }
      }
    } else if (Array.isArray(payload.messages) && payload.messages.length >= 2) {
      const prefixTokens = this.estimateTokens(
        JSON.stringify(payload.messages.slice(0, payload.messages.length - 1))
      );
      if (prefixTokens >= 1024) {
        eligibleTokens += prefixTokens;
      }
    }

    return eligibleTokens;
  }

  private injectSystemToolDirective(payload: Record<string, unknown>): void {
    if (!Array.isArray(payload.tools)) return;

    const hasDietTools = payload.tools.some((t: unknown) => {
      const tool = t as Record<string, unknown>;
      const fn = (tool.function as Record<string, unknown>) ?? tool;
      return String(fn?.name ?? '').startsWith('diet_');
    });
    if (!hasDietTools) return;

    const directive =
      '\n\n[Diet Toke Policy]: Prefer `diet_workspace_map`, `diet_read_relevant`, and `diet_read_skeleton` before full-file reads; only read full files when editing.';

    if (typeof payload.system === 'string' && !payload.system.includes('[Diet Toke Policy]')) {
      payload.system += directive;
    } else if (Array.isArray(payload.system) && payload.system.length > 0) {
      const first = payload.system[0] as Record<string, unknown>;
      if (typeof first?.text === 'string' && !first.text.includes('[Diet Toke Policy]')) {
        first.text += directive;
      }
    }

    if (Array.isArray(payload.messages)) {
      const sysMsg = payload.messages.find(
        (m: { role?: string }) => m.role === 'system' || m.role === 'developer'
      ) as { content?: unknown } | undefined;
      if (
        sysMsg &&
        typeof sysMsg.content === 'string' &&
        !sysMsg.content.includes('[Diet Toke Policy]')
      ) {
        sysMsg.content += directive;
      }
    }
  }

  private detectRepeatedToolLoop(messages: Array<{ tool_calls?: unknown[] }>): string | null {
    const counts = new Map<string, number>();
    for (const m of messages) {
      if (!Array.isArray(m.tool_calls)) continue;
      for (const tc of m.tool_calls) {
        const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
        if (!fn?.name) continue;
        const sig = `${fn.name}(${fn.arguments ?? ''})`;
        const next = (counts.get(sig) ?? 0) + 1;
        counts.set(sig, next);
        if (next >= 3) {
          return sig;
        }
      }
    }
    return null;
  }

  public compressApiPayload(
    rawBody: string,
    options: CompressOptions,
    isAnthropic = false
  ): { body: string; savedTokens: number } {
    const origTokens = this.estimateTokens(rawBody);
    if (!options.enabled || !rawBody) {
      return { body: rawBody, savedTokens: 0 };
    }

    try {
      const payload = JSON.parse(rawBody) as Record<string, unknown>;
      const hasNativeTools = Array.isArray(payload.tools) && payload.tools.length > 0;
      const latestUserText = Array.isArray(payload.messages)
        ? this.extractLatestUserText(payload.messages)
        : '';
      const editingMode = this.isEditIntent(latestUserText);
      const activeBasenames = Array.isArray(payload.messages)
        ? this.extractVisibleBasenames(payload.messages, options.activeFileBasename)
        : new Set(options.activeFileBasename ? [options.activeFileBasename] : []);
      const promptSymbols = this.extractPromptIdentifiers(latestUserText);
      const dependencySymbols = new Set<string>(promptSymbols);
      if (options.activeFileCode) {
        for (const sym of this.slicer.extractReferencedSymbols(options.activeFileCode)) {
          dependencySymbols.add(sym);
        }
      }

      const otherLayersBefore =
        this.stats.savedByLayer.toolPruning +
        this.stats.savedByLayer.logDistillation +
        this.stats.savedByLayer.historyAndDedup;

      if (isAnthropic && typeof payload.system === 'string' && payload.system.length > 1200) {
        const distilledSys = this.distillSystemPrompt(payload.system, latestUserText, hasNativeTools);
        this.stats.savedByLayer.historyAndDedup += Math.max(
          0,
          this.estimateTokens(payload.system) - this.estimateTokens(distilledSys)
        );
        payload.system = distilledSys;
      } else if (isAnthropic && Array.isArray(payload.system)) {
        payload.system = payload.system.map((part) => {
          if (!part || typeof part !== 'object') return part;
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string' && p.text.length > 1200) {
            const distilledSys = this.distillSystemPrompt(p.text, latestUserText, hasNativeTools);
            this.stats.savedByLayer.historyAndDedup += Math.max(
              0,
              this.estimateTokens(p.text) - this.estimateTokens(distilledSys)
            );
            return { ...p, text: distilledSys };
          }
          return part;
        });
      }

      if (options.pruneTools && Array.isArray(payload.tools)) {
        const beforeTools = this.estimateTokens(JSON.stringify(payload.tools));
        payload.tools = this.pruneUnusedTools(
          payload.tools as Array<Record<string, unknown>>,
          latestUserText
        );
        const afterTools = this.estimateTokens(JSON.stringify(payload.tools));
        this.stats.savedByLayer.toolPruning += Math.max(0, beforeTools - afterTools);
      }

      if (Array.isArray(payload.messages)) {
        const seenInPayload = new Set<string>();
        const rawMsgs = payload.messages as Array<{
          role?: string;
          content?: unknown;
          tool_calls?: unknown[];
        }>;
        const repeatedSig = this.detectRepeatedToolLoop(rawMsgs);

        let cutoff = Math.max(2, rawMsgs.length - 4);
        while (cutoff > 2 && cutoff < rawMsgs.length && rawMsgs[cutoff]?.role === 'tool') {
          cutoff--;
        }

        const compressToolText = (rawToolText: string): string => {
          const distilled = this.distillToolOutput(rawToolText);
          this.stats.savedByLayer.logDistillation += Math.max(
            0,
            this.estimateTokens(rawToolText) - this.estimateTokens(distilled)
          );
          return this.compressPromptText(
            distilled,
            activeBasenames,
            dependencySymbols,
            editingMode,
            promptSymbols,
            seenInPayload
          );
        };

        const compactSingleMessage = (
          msg: {
            role?: string;
            type?: string;
            output?: unknown;
            content?: unknown;
            tool_calls?: unknown[];
          },
          idx: number
        ) => {
          if (msg.type === 'function_call_output' && typeof msg.output === 'string') {
            return { ...msg, output: compressToolText(msg.output) };
          }

          if (msg.role === 'system' || msg.role === 'developer') {
            if (typeof msg.content === 'string' && msg.content.length > 1200) {
              const distilledSys = this.distillSystemPrompt(
                msg.content,
                latestUserText,
                hasNativeTools
              );
              this.stats.savedByLayer.historyAndDedup += Math.max(
                0,
                this.estimateTokens(msg.content) - this.estimateTokens(distilledSys)
              );
              return { ...msg, content: distilledSys };
            }
            return msg;
          }

          if (msg.role === 'tool' && typeof msg.content === 'string') {
            return { ...msg, content: compressToolText(msg.content) };
          }

          const stripAllEnv = idx > 1 && idx < rawMsgs.length - 1;
          if (typeof msg.content === 'string') {
            let text = this.compactEnvironmentDetails(
              msg.content,
              stripAllEnv,
              latestUserText,
              options.workspaceRoot
            );
            text = this.compressPromptText(
              text,
              activeBasenames,
              dependencySymbols,
              editingMode,
              promptSymbols,
              seenInPayload
            );
            return { ...msg, content: text };
          }

          if (Array.isArray(msg.content)) {
            return {
              ...msg,
              content: msg.content.map((part: Record<string, unknown>) => {
                if (part.type === 'text' && typeof part.text === 'string') {
                  if (msg.role === 'tool') {
                    return { ...part, text: compressToolText(part.text) };
                  }
                  let text = this.compactEnvironmentDetails(
                    part.text,
                    stripAllEnv,
                    latestUserText,
                    options.workspaceRoot
                  );
                  text = this.compressPromptText(
                    text,
                    activeBasenames,
                    dependencySymbols,
                    editingMode,
                    promptSymbols,
                    seenInPayload
                  );
                  return { ...part, text };
                }
                if (part.type === 'tool_result') {
                  if (typeof part.content === 'string') {
                    return { ...part, content: compressToolText(part.content) };
                  }
                  if (Array.isArray(part.content)) {
                    return {
                      ...part,
                      content: part.content.map((sub: Record<string, unknown>) =>
                        sub?.type === 'text' && typeof sub.text === 'string'
                          ? { ...sub, text: compressToolText(sub.text) }
                          : sub
                      )
                    };
                  }
                }
                return part;
              })
            };
          }

          return msg;
        };

        if (cutoff > 2) {
          const head = rawMsgs.slice(0, 2).map((m, i) => compactSingleMessage(m, i));
          const foldedSlice = rawMsgs.slice(2, cutoff);
          const foldedTokens = this.estimateTokens(JSON.stringify(foldedSlice));
          const completedCalls = foldedSlice
            .flatMap((m) => {
              const found: string[] = [];
              if (Array.isArray(m.tool_calls)) {
                for (const tc of m.tool_calls) {
                  const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
                  if (fn?.name) found.push(`${fn.name}(${fn.arguments ?? ""})`);
                }
              }
              if (Array.isArray(m.content)) {
                for (const part of m.content as Array<Record<string, unknown>>) {
                  if (part?.type === "tool_use" && typeof part.name === "string") {
                    found.push(`${part.name}(${JSON.stringify(part.input ?? {})})`);
                  }
                }
              }
              if (typeof m.content === "string") {
                for (const xm of m.content.matchAll(/<([a-z_]+)>\s*<path>([^<]+)<\/path>/gi)) {
                  found.push(`${xm[1]}(${xm[2]})`);
                }
              }
              return found;
            })
            .filter(Boolean);
          const callSummary =
            completedCalls.length > 0 ? ` Already ran: ${completedCalls.join(', ')}.` : '';
          const note = `\n[Diet Toke: ${foldedSlice.length} earlier steps completed.${callSummary} Do not repeat these calls.]`;

          if (head[1] && typeof head[1].content === 'string') {
            head[1] = { ...head[1], content: head[1].content + note };
          } else if (head[1] && Array.isArray(head[1].content)) {
            head[1] = {
              ...head[1],
              content: [...head[1].content, { type: 'text', text: note }]
            };
          }

          this.stats.savedByLayer.historyAndDedup += Math.max(
            0,
            foldedTokens - this.estimateTokens(note)
          );
          const tail = rawMsgs.slice(cutoff).map((m, i) => compactSingleMessage(m, cutoff + i));
          payload.messages = [...head, ...tail];
        } else {
          payload.messages = rawMsgs.map((m, i) => compactSingleMessage(m, i));
        }

        if (repeatedSig && Array.isArray(payload.messages) && payload.messages.length > 0) {
          const lastIdx = payload.messages.length - 1;
          const lastMsg = payload.messages[lastIdx] as { content?: unknown };
          const stopNotice = `\n[STOP LOOP: You already called ${repeatedSig} 3+ times. Do NOT call it again—immediately call attempt_completion and answer the user now.]`;
          if (typeof lastMsg.content === 'string') {
            payload.messages[lastIdx] = { ...lastMsg, content: lastMsg.content + stopNotice };
          } else if (Array.isArray(lastMsg.content)) {
            payload.messages[lastIdx] = {
              ...lastMsg,
              content: [...lastMsg.content, { type: 'text', text: stopNotice }]
            };
          }
        }
      }

      if (Array.isArray(payload.contents)) {
        compressGeminiPayload(payload, options, {
          stats: this.stats,
          estimateTokens: (t) => this.estimateTokens(t),
          classifyPromptIntent: (p) => this.classifyPromptIntent(p),
          needsCommandExecution: (p, i) => this.needsCommandExecution(p, i),
          distillSystemPrompt: (s, u, h) => this.distillSystemPrompt(s, u, h),
          distillToolOutput: (o) => this.distillToolOutput(o),
          compactEnvironmentDetails: (t, o, u, w) => this.compactEnvironmentDetails(t, o, u, w),
          compressPromptText: (t, a, d, e, p, s) => this.compressPromptText(t, a, d, e, p, s),
          extractVisibleBasenames: (m, f) => this.extractVisibleBasenames(m, f),
          extractPromptIdentifiers: (p) => this.extractPromptIdentifiers(p),
          extractReferencedSymbols: (code) => this.slicer.extractReferencedSymbols(code)
        });
      }

      this.injectSystemToolDirective(payload);

      let cacheEligible = 0;
      if (options.injectPromptCache) {
        cacheEligible = this.applyPromptCaching(payload, isAnthropic);
        this.stats.cacheEligibleTokens += cacheEligible;
      }

      const compressedBody = JSON.stringify(payload);
      const newTokens = this.estimateTokens(compressedBody);
      const saved = Math.max(0, origTokens - newTokens);

      const otherLayersAfter =
        this.stats.savedByLayer.toolPruning +
        this.stats.savedByLayer.logDistillation +
        this.stats.savedByLayer.historyAndDedup;
      const otherLayersDelta = Math.max(0, otherLayersAfter - otherLayersBefore);
      this.stats.savedByLayer.slicingAndSkeleton += Math.max(0, saved - otherLayersDelta);

      this.stats.requestsProcessed += 1;
      this.stats.originalTokens += origTokens;
      this.stats.compressedTokens += newTokens;

      this.stats.lifetime.requestsProcessed += 1;
      this.stats.lifetime.originalTokens += origTokens;
      this.stats.lifetime.compressedTokens += newTokens;
      this.stats.lifetime.cacheEligibleTokens += cacheEligible;

      const rawModel = typeof payload.model === "string" ? payload.model : options.requestModel;
      const rates = this.computeModelRates(rawModel, options.upstreamHostname, options.upstreamPort);
      const reqUsd = rates.isLocal
        ? 0
        : (saved / 1_000_000) * rates.inputPerMillion +
          (cacheEligible / 1_000_000) * rates.cacheDiscountPerMillion;
      this.stats.costSavedUsd += reqUsd;
      this.stats.lifetime.costSavedUsd = (this.stats.lifetime.costSavedUsd ?? 0) + reqUsd;
      this.stats.lastModel = rates.label;
      this.stats.lastProviderLocal = rates.isLocal;

      this.stats.recentRequests.push({
        timestamp: new Date().toLocaleTimeString(),
        source: isAnthropic ? "Anthropic Proxy" : "OpenAI/Gemini Proxy",
        model: rates.label,
        originalTokens: origTokens,
        compressedTokens: newTokens,
        savedTokens: saved,
        costSavedUsd: reqUsd,
        isLocal: rates.isLocal
      });
      if (this.stats.recentRequests.length > 25) {
        this.stats.recentRequests.shift();
      }

      return { body: compressedBody, savedTokens: saved };
    } catch {
      return { body: rawBody, savedTokens: 0 };
    }
  }
}