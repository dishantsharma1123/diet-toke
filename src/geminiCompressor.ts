import type { CompressOptions, CompressionStats } from './compressor';

export interface GeminiCompressionDeps {
  stats: CompressionStats;
  estimateTokens: (text: string) => number;
  classifyPromptIntent: (prompt: string) => 'read-only' | 'edit' | 'ambiguous';
  needsCommandExecution: (prompt: string, intent: 'read-only' | 'edit' | 'ambiguous') => boolean;
  distillSystemPrompt: (content: string, latestUserPrompt: string, hasNativeTools: boolean) => string;
  distillToolOutput: (output: string) => string;
  compactEnvironmentDetails: (
    text: string,
    isOldTurn: boolean,
    latestUserPrompt: string,
    fallbackWorkspaceRoot?: string
  ) => string;
  compressPromptText: (
    text: string,
    activeBasenames?: Set<string>,
    dependencySymbols?: Set<string>,
    editingMode?: boolean,
    promptSymbols?: Set<string>,
    seenInPayload?: Set<string>
  ) => string;
  extractVisibleBasenames: (messages: unknown[], fallbackBasename?: string) => Set<string>;
  extractPromptIdentifiers: (prompt: string) => Set<string>;
  extractReferencedSymbols: (code: string) => Iterable<string>;
}

function extractLatestGeminiUserText(contents: unknown[]): string {
  let fallback = '';
  for (let i = contents.length - 1; i >= 0; i--) {
    const entry = contents[i] as { role?: string; parts?: Array<Record<string, unknown>> } | undefined;
    if (!entry || entry.role === 'model' || !Array.isArray(entry.parts)) continue;

    const raw = entry.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
    if (!raw.trim()) continue;

    const taskMatch = raw.match(/<task>([\s\S]*?)<\/task>/i);
    if (taskMatch) return taskMatch[1].trim();

    const cleaned = raw.replace(/<environment_details>[\s\S]*?<\/environment_details>/gi, '').trim();
    if (!cleaned || /^\[[a-z0-9_ -]+(?:\s+for\s+['"][^'"]+['"])?\]\s*Result:/i.test(cleaned) || /^\/\/ Resolved path:/i.test(cleaned)) {
      continue;
    }
    if (!fallback) fallback = cleaned;
  }
  return fallback;
}

export function compressGeminiPayload(
  payload: Record<string, unknown>,
  options: CompressOptions,
  deps: GeminiCompressionDeps
): void {
  const rawContents = payload.contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>;
  const latestUserText = extractLatestGeminiUserText(rawContents);
  const intent = deps.classifyPromptIntent(latestUserText);
  const editingMode = intent !== 'read-only';
  const execAllowed = deps.needsCommandExecution(latestUserText, intent);

  const wrappedForBasenames = rawContents.map((e) => ({
    content: Array.isArray(e.parts)
      ? e.parts.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
      : ''
  }));
  const activeBasenames = deps.extractVisibleBasenames(wrappedForBasenames, options.activeFileBasename);
  const promptSymbols = deps.extractPromptIdentifiers(latestUserText);
  const dependencySymbols = new Set<string>(promptSymbols);
  if (options.activeFileCode) {
    for (const sym of deps.extractReferencedSymbols(options.activeFileCode)) {
      dependencySymbols.add(sym);
    }
  }

  const hasNativeTools =
    Array.isArray(payload.tools) &&
    payload.tools.some((t: unknown) => Array.isArray((t as Record<string, unknown>)?.functionDeclarations));

  if (payload.systemInstruction) {
    if (typeof payload.systemInstruction === 'string' && payload.systemInstruction.length > 1200) {
      const distilled = deps.distillSystemPrompt(payload.systemInstruction, latestUserText, hasNativeTools);
      deps.stats.savedByLayer.historyAndDedup += Math.max(
        0,
        deps.estimateTokens(payload.systemInstruction) - deps.estimateTokens(distilled)
      );
      payload.systemInstruction = distilled;
    } else if (typeof payload.systemInstruction === 'object' && Array.isArray((payload.systemInstruction as { parts?: unknown[] }).parts)) {
      const sysObj = payload.systemInstruction as { parts: Array<Record<string, unknown>> };
      sysObj.parts = sysObj.parts.map((part) => {
        if (typeof part?.text === 'string' && part.text.length > 1200) {
          const distilled = deps.distillSystemPrompt(part.text, latestUserText, hasNativeTools);
          deps.stats.savedByLayer.historyAndDedup += Math.max(
            0,
            deps.estimateTokens(part.text) - deps.estimateTokens(distilled)
          );
          return { ...part, text: distilled };
        }
        return part;
      });
    }
  }

  if (options.pruneTools && Array.isArray(payload.tools)) {
    const beforeTools = deps.estimateTokens(JSON.stringify(payload.tools));
    const keywords = new Set(latestUserText.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 2));
    const coreRegex = /(read|file|search|grep|find|list|dir|tree|symbol|definition|mcp|diet_|ask|attempt|complet|view|inspect)/i;
    const editRegex = /(edit|write|replace|patch|apply|insert|create|modify|update|delete|remove)/i;
    const execRegex = /(exec|command|bash|shell|terminal|run)/i;

    payload.tools = payload.tools.map((t: unknown) => {
      const toolObj = t as Record<string, unknown>;
      if (!Array.isArray(toolObj.functionDeclarations) || toolObj.functionDeclarations.length === 0) return toolObj;
      const decls = toolObj.functionDeclarations as Array<Record<string, unknown>>;
      const filtered = decls.filter((d) => {
        const name = String(d.name ?? '');
        if (!name) return true;
        if (editRegex.test(name)) return editingMode;
        if (execRegex.test(name)) return execAllowed;
        if (coreRegex.test(name)) return true;
        for (const w of keywords) {
          if (w.length >= 4 && name.toLowerCase().includes(w)) return true;
        }
        return false;
      });
      const effective = filtered.length > 0 ? filtered : decls;
      return {
        ...toolObj,
        functionDeclarations: effective.map((d) => ({
          ...d,
          description: typeof d.description === 'string' ? d.description.split('.')[0].slice(0, 140) : ''
        }))
      };
    });

    const afterTools = deps.estimateTokens(JSON.stringify(payload.tools));
    deps.stats.savedByLayer.toolPruning += Math.max(0, beforeTools - afterTools);
  }

  const seen = new Set<string>();
  const compressToolText = (raw: string): string => {
    const distilled = deps.distillToolOutput(raw);
    deps.stats.savedByLayer.logDistillation += Math.max(
      0,
      deps.estimateTokens(raw) - deps.estimateTokens(distilled)
    );
    return deps.compressPromptText(distilled, activeBasenames, dependencySymbols, editingMode, promptSymbols, seen);
  };

  let cutoff = Math.max(2, rawContents.length - 4);
  while (
    cutoff > 2 &&
    cutoff < rawContents.length &&
    Array.isArray(rawContents[cutoff]?.parts) &&
    rawContents[cutoff].parts!.some((p) => p && typeof p === 'object' && 'functionResponse' in p)
  ) {
    cutoff--;
  }

  const compactEntry = (entry: { role?: string; parts?: Array<Record<string, unknown>> }, idx: number) => {
    if (!Array.isArray(entry.parts)) return entry;
    const stripEnv = idx > 0 && idx > 0 && idx < rawContents.length - 1;
    return {
      ...entry,
      parts: entry.parts.map((part) => {
        if (typeof part.text === 'string') {
          let text = deps.compactEnvironmentDetails(part.text, stripEnv, latestUserText, options.workspaceRoot);
          text = deps.compressPromptText(text, activeBasenames, dependencySymbols, editingMode, promptSymbols, seen);
          return { ...part, text };
        }
        if (part.functionResponse && typeof part.functionResponse === 'object') {
          const fr = part.functionResponse as Record<string, unknown>;
          if (typeof fr.response === 'string') {
            return { ...part, functionResponse: { ...fr, response: compressToolText(fr.response) } };
          }
          if (fr.response && typeof fr.response === 'object') {
            const updated: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(fr.response as Record<string, unknown>)) {
              updated[k] = typeof v === 'string' ? compressToolText(v) : v;
            }
            return { ...part, functionResponse: { ...fr, response: updated } };
          }
        }
        return part;
      })
    };
  };

  if (cutoff > 2) {
    const head = rawContents.slice(0, 2).map((e, i) => compactEntry(e, i));
    const folded = rawContents.slice(2, cutoff);
    const foldedTokens = deps.estimateTokens(JSON.stringify(folded));
    const note = `\n[Diet Toke: ${folded.length} earlier turns completed. Do not repeat these calls.]`;
    if (head[1] && Array.isArray(head[1].parts)) {
      head[1] = { ...head[1], parts: [...head[1].parts, { text: note }] };
    }
    deps.stats.savedByLayer.historyAndDedup += Math.max(0, foldedTokens - deps.estimateTokens(note));
    payload.contents = [...head, ...rawContents.slice(cutoff).map((e, i) => compactEntry(e, cutoff + i))];
  } else {
    payload.contents = rawContents.map((e, i) => compactEntry(e, i));
  }
}
