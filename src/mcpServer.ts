import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { TokenCompressor } from './compressor';

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

interface ResolvedFile {
  absPath: string;
  relPath: string;
  ambiguousMatches?: string[];
}

export class DietMcpHandler {
  private failedLookups = new Map<string, number>();

  constructor(
    private readonly compressor: TokenCompressor,
    private readonly getWorkspaceRoots?: () => string[]
  ) {}

  private getAllRoots(): string[] {
    const roots = new Set<string>();
    if (this.getWorkspaceRoots) {
      for (const r of this.getWorkspaceRoots()) {
        if (r && fs.existsSync(r)) roots.add(r);
      }
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (fs.existsSync(folder.uri.fsPath)) {
        roots.add(folder.uri.fsPath);
      }
    }
    return Array.from(roots);
  }

  private resolveWorkspaceFile(requestedPath: string): ResolvedFile | null {
    const cleanReq = requestedPath.trim().replace(/\\/g, '/');
    if (!cleanReq) return null;

    const roots = this.getAllRoots();

    // 1. Direct absolute path
    if (path.isAbsolute(cleanReq) && fs.existsSync(cleanReq) && fs.statSync(cleanReq).isFile()) {
      const ownerRoot = roots.find((r) => cleanReq.startsWith(r));
      return {
        absPath: cleanReq,
        relPath: ownerRoot ? path.relative(ownerRoot, cleanReq).replace(/\\/g, '/') : cleanReq
      };
    }

    // 2. Exact workspace-relative match across all registered workspace roots
    for (const root of roots) {
      const candidate = path.join(root, cleanReq);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return {
          absPath: candidate,
          relPath: path.relative(root, candidate).replace(/\\/g, '/')
        };
      }
    }

    // 3. Recursive subdirectory search by relative suffix or basename
    const targetBase = path.basename(cleanReq).toLowerCase();
    const matches: Array<{ absPath: string; relPath: string }> = [];

    for (const root of roots) {
      const walk = (dir: string, depth: number) => {
        if (depth > 7 || matches.length >= 15) return;
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
            const full = path.join(dir, entry.name);
            const rel = path.relative(root, full).replace(/\\/g, '/');
            if (
              entry.name.toLowerCase() === targetBase ||
              rel.toLowerCase().endsWith(`/${cleanReq.toLowerCase()}`)
            ) {
              matches.push({ absPath: full, relPath: rel });
            }
          }
        }
      };

      walk(root, 0);
      if (matches.length > 0) break;
    }

    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      return {
        absPath: matches[0].absPath,
        relPath: matches[0].relPath,
        ambiguousMatches: matches.map((m) => m.relPath)
      };
    }

    return null;
  }

  /**
   * Breadth-first workspace map capped at 60 lines so top-level folders are always visible
   * and Cline never spills the result into cline://cache/*.result.txt.
   */
  private buildWorkspaceMap(maxFiles = 100): string {
    const cap = Math.min(Math.max(15, maxFiles), 150);
    const roots = this.getAllRoots();
    if (roots.length === 0) {
      return 'No open workspace folders detected.';
    }

    const lines: string[] = [];
    for (const root of roots) {
      if (lines.length >= cap) break;
      lines.push(`Workspace: ${path.basename(root)} (${root})`);

      const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
      while (queue.length > 0 && lines.length < cap) {
        const current = queue.shift()!;
        if (current.depth > 5) continue;

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const entry of entries) {
          if (lines.length >= cap) break;
          if (!isAllowedWorkspaceEntry(entry.name, entry.isDirectory())) continue;

          const full = path.join(current.dir, entry.name);
          const rel = path.relative(root, full).replace(/\\/g, '/');
          if (entry.isDirectory()) {
            lines.push(`- ${rel}/`);
            queue.push({ dir: full, depth: current.depth + 1 });
          } else if (entry.isFile()) {
            lines.push(`- ${rel}`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  public async handleRpc(rpcReq: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const id = rpcReq.id ?? null;
    const method = String(rpcReq.method ?? '');

    if (method === 'notifications/initialized' || id === null) {
      return null;
    }

    if (method === 'initialize') {
      this.failedLookups.clear();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'diet-toke', version: '1.0.0' }
        }
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'diet_workspace_map',
              description:
                'Returns a compact breadth-first map of workspace directories and files (max 60 entries).',
              inputSchema: {
                type: 'object',
                properties: {
                  maxFiles: { type: 'number', description: 'Maximum entries to list (default 60)' }
                }
              }
            },
            {
              name: 'diet_read_relevant',
              description:
                'Reads ONLY the functions, types, and call-site windows matching the requested symbols from a file (resolves nested paths automatically).',
              inputSchema: {
                type: 'object',
                properties: {
                  filePath: { type: 'string', description: 'Workspace-relative path or filename' },
                  symbols: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Function, class, or variable names to inspect'
                  }
                },
                required: ['filePath']
              }
            },
            {
              name: 'diet_read_skeleton',
              description:
                'Reads a file with function bodies stripped, preserving types, interfaces, imports, and signatures.',
              inputSchema: {
                type: 'object',
                properties: {
                  filePath: { type: 'string', description: 'Workspace-relative path or filename' }
                },
                required: ['filePath']
              }
            },
            {
              name: 'diet_read_full_file',
              description:
                'Reads the full, unstripped source code of a file. Supports optional startLine and endLine.',
              inputSchema: {
                type: 'object',
                properties: {
                  filePath: { type: 'string', description: 'Workspace-relative path or filename' },
                  startLine: { type: 'number' },
                  endLine: { type: 'number' }
                },
                required: ['filePath']
              }
            }
          ]
        }
      };
    }

    if (method === 'tools/call') {
      const params = (rpcReq.params as Record<string, unknown>) ?? {};
      const toolName = String(params.name ?? '');
      const args = (params.arguments as Record<string, unknown>) ?? {};
      const text = this.executeTool(toolName, args);

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }]
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    };
  }

  private executeTool(name: string, args: Record<string, unknown>): string {
    if (name === 'diet_workspace_map') {
      const maxFiles = typeof args.maxFiles === 'number' ? args.maxFiles : 100;
      return this.buildWorkspaceMap(maxFiles);
    }

    const filePath = String(args.filePath ?? '');
    const resolved = this.resolveWorkspaceFile(filePath);
    if (!resolved) {
      const key = `${name}:${filePath}`;
      const attempts = (this.failedLookups.get(key) ?? 0) + 1;
      this.failedLookups.set(key, attempts);
      const workspaceNames = this.getAllRoots().map((r) => path.basename(r)).join(', ') || 'none';

      if (attempts >= 2) {
        return `STOP: "${filePath}" does NOT exist anywhere in the open workspaces (${workspaceNames}). Do NOT call ${name} or any read tool on "${filePath}" again. Immediately call attempt_completion to report this to the user.`;
      }
      return `File "${filePath}" was not found anywhere in the open workspaces (${workspaceNames}). Do NOT retry reading "${filePath}"; either call diet_workspace_map once or call attempt_completion to tell the user it is not in this workspace.`;
    }

    if (resolved.ambiguousMatches) {
      return `Multiple files match "${filePath}":\n${resolved.ambiguousMatches.map((m) => `- ${m}`).join('\n')}\nRe-call with the exact workspace-relative path.`;
    }

    const raw = fs.readFileSync(resolved.absPath, 'utf8');

    if (name === 'diet_read_skeleton') {
      const skeleton = this.compressor.skeletonizeCode(raw, resolved.relPath);
      return `// Resolved path: ${resolved.relPath}\n${skeleton}`;
    }

    if (name === 'diet_read_relevant') {
      const rawSymbols = Array.isArray(args.symbols) ? args.symbols.map(String) : [];
      const symbolSet = new Set(rawSymbols.filter(Boolean));
      const sliced =
        symbolSet.size > 0
          ? this.compressor.compressDependencyCode(raw, resolved.relPath, symbolSet, true)
          : this.compressor.skeletonizeCode(raw, resolved.relPath);
      return `// Resolved path: ${resolved.relPath}\n${sliced}`;
    }

    if (name === 'diet_read_full_file') {
      const lines = raw.split('\n');
      const start = typeof args.startLine === 'number' ? Math.max(1, args.startLine) : 1;
      const end = typeof args.endLine === 'number' ? Math.min(lines.length, args.endLine) : lines.length;
      const slice = lines
        .slice(start - 1, end)
        .map((line, i) => `${start + i} | ${line}`)
        .join('\n');
      return `// Resolved path: ${resolved.relPath} (lines ${start}-${end} of ${lines.length})\n${slice}`;
    }

    return `Unknown Diet Toke MCP tool: ${name}`;
  }
}