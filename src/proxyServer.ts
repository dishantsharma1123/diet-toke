import * as fs from 'fs';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { TokenCompressor } from './compressor';
import { DietMcpHandler } from './mcpServer';

interface UpstreamTarget {
  protocol: 'http:' | 'https:';
  hostname: string;
  port: number;
  rewrittenPath: string;
  isAnthropic: boolean;
}

export class DietProxyServer {
  private server: http.Server | null = null;
  public activePort = 0;
  private lastCodeEditor: vscode.TextEditor | undefined = vscode.window.activeTextEditor;
  private windowStates = new Map<string, { roots: string[]; activeFile?: string; updatedAt: number }>();

  public getRegisteredRoots(): string[] {
    const all = new Set<string>();
    for (const s of this.windowStates.values()) for (const r of s.roots) all.add(r);
    return Array.from(all);
  }

  private normalizeFsPath(p: string): string {
    if (!p) return "";
    const exp = p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
    return path.resolve(exp);
  }

  private extractRequestCwd(rawBody: string, headers: http.IncomingHttpHeaders): string | undefined {
    const hdr = headers["x-workspace-root"];
    if (typeof hdr === "string" && hdr.trim()) return this.normalizeFsPath(hdr.trim());
    const m =
      rawBody.match(/# Current Working Directory \(([^)]+)\)/) ||
      rawBody.match(/# Current Working Directory[^\n\\]*(?:\\r?\\n|\r?\n)([^\\n#"\r\n]+)/) ||
      rawBody.match(/# Workspace Directory[^\n\\]*(?:\\r?\\n|\r?\n)([^\\n#"\r\n]+)/);
    return m?.[1]?.trim() ? this.normalizeFsPath(m[1].trim()) : undefined;
  }

  private resolveWindowContext(requestCwd?: string): { activeFile?: string; workspaceRoot?: string } {
    const localFolders = (vscode.workspace.workspaceFolders ?? []).map((f) => this.normalizeFsPath(f.uri.fsPath));
    const cur = vscode.window.activeTextEditor;
    const localEd = cur && cur.document.uri.scheme === "file" ? cur : this.lastCodeEditor;
    const localPath = localEd?.document.fileName ? this.normalizeFsPath(localEd.document.fileName) : undefined;

    if (requestCwd) {
      const isLocal = localFolders.some((f) => requestCwd === f || requestCwd.startsWith(f + path.sep));
      if (isLocal) {
        const edMatches = localPath && (localPath === requestCwd || localPath.startsWith(requestCwd + path.sep));
        const st = Array.from(this.windowStates.values()).find((s) =>
          s.roots.some((r) => requestCwd === r || requestCwd.startsWith(r + path.sep))
        );
        return { activeFile: edMatches ? localPath : st?.activeFile, workspaceRoot: requestCwd };
      }
      let best: { roots: string[]; activeFile?: string; updatedAt: number } | undefined;
      for (const s of this.windowStates.values()) {
        if (s.roots.some((r) => requestCwd === r || requestCwd.startsWith(r + path.sep))) {
          if (!best || s.updatedAt > best.updatedAt) best = s;
        }
      }
      return { activeFile: best?.activeFile, workspaceRoot: requestCwd };
    }

    if (localPath) {
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(localPath));
      return { activeFile: localPath, workspaceRoot: folder?.uri.fsPath ?? localFolders[0] };
    }
    const latest = Array.from(this.windowStates.values()).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return { activeFile: latest?.activeFile, workspaceRoot: localFolders[0] ?? latest?.roots[0] };
  }

  constructor(
    private readonly compressor: TokenCompressor,
    private readonly mcpHandler: DietMcpHandler,
    private readonly onStatsUpdated: () => void
  ) {
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && editor.document.uri.scheme === 'file') {
        this.lastCodeEditor = editor;
      }
    });
  }

  public async start(preferredPort: number): Promise<number> {
    if (this.server) return this.activePort;

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Diet Toke proxy error', details: String(err) }));
        }
      });
    });

    return new Promise((resolve, reject) => {
      const tryListen = (port: number) => {
        this.server!.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && port !== 0) {
            tryListen(0);
          } else {
            reject(err);
          }
        });

        this.server!.listen(port, '127.0.0.1', () => {
          const addr = this.server!.address();
          this.activePort = typeof addr === 'object' && addr ? addr.port : port;
          resolve(this.activePort);
        });
      };

      tryListen(preferredPort);
    });
  }

  public stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.activePort = 0;
    }
  }

  private resolveUpstream(urlPath: string): UpstreamTarget | null {
    // Dynamic custom provider route: /proxy/<base64url>/chat/completions
    const proxyMatch = urlPath.match(/^\/proxy\/([A-Za-z0-9_-]+)(\/.*|\?.*)?$/);
    if (proxyMatch) {
      try {
        const encodedBase = proxyMatch[1];
        const suffix = proxyMatch[2] ?? '';
        const upstreamBase = Buffer.from(encodedBase, 'base64url').toString('utf8');
        const parsed = new URL(upstreamBase);

        const qIdx = suffix.indexOf('?');
        const suffixPath = qIdx >= 0 ? suffix.slice(0, qIdx) : suffix;
        const suffixQuery = qIdx >= 0 ? suffix.slice(qIdx) : '';
        const basePath = parsed.pathname.replace(/\/+$/, '');
        const rewrittenPath = `${basePath}${suffixPath}${suffixQuery || parsed.search}` || '/';
        const protocol = parsed.protocol === 'http:' ? 'http:' : 'https:';
        const port = parsed.port ? Number(parsed.port) : protocol === 'http:' ? 80 : 443;

        return {
          protocol,
          hostname: parsed.hostname,
          port,
          rewrittenPath,
          isAnthropic: rewrittenPath.includes('/messages')
        };
      } catch {
        return null;
      }
    }

    if (urlPath.startsWith('/openai/')) {
      return {
        protocol: 'https:',
        hostname: 'api.openai.com',
        port: 443,
        rewrittenPath: urlPath.replace(/^\/openai/, ''),
        isAnthropic: false
      };
    }
    if (urlPath.startsWith('/anthropic/')) {
      return {
        protocol: 'https:',
        hostname: 'api.anthropic.com',
        port: 443,
        rewrittenPath: urlPath.replace(/^\/anthropic/, ''),
        isAnthropic: true
      };
    }
    if (urlPath.startsWith('/gemini/')) {
      return {
        protocol: 'https:',
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        rewrittenPath: urlPath.replace(/^\/gemini/, ''),
        isAnthropic: false
      };
    }

    if (urlPath.startsWith('/v1/messages')) {
      return {
        protocol: 'https:',
        hostname: 'api.anthropic.com',
        port: 443,
        rewrittenPath: urlPath,
        isAnthropic: true
      };
    }
    if (urlPath.startsWith('/v1beta/')) {
      return {
        protocol: 'https:',
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        rewrittenPath: urlPath,
        isAnthropic: false
      };
    }
    if (urlPath.startsWith('/v1/')) {
      return {
        protocol: 'https:',
        hostname: 'api.openai.com',
        port: 443,
        rewrittenPath: urlPath,
        isAnthropic: false
      };
    }

    return null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const urlPath = req.url ?? '/';

    if (urlPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: this.activePort, stats: this.compressor.stats }));
      return;
    }

    if (urlPath.startsWith('/reset')) {
      const parsedUrl = new URL(urlPath, 'http://127.0.0.1');
      const scope = parsedUrl.searchParams.get('scope') ?? 'session';
      if (scope === 'lifetime') {
        this.compressor.resetLifetimeStats();
      } else if (scope === 'cache') {
        this.compressor.resetCache();
      } else {
        this.compressor.resetStats();
      }
      this.onStatsUpdated();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', stats: this.compressor.stats }));
      return;
    }

    if (urlPath === '/register-workspace') {
      const body = await this.readBody(req);
      try {
        const data = JSON.parse(body) as { roots?: string[]; activeFile?: string };
        const roots = Array.isArray(data.roots)
          ? data.roots.filter((r) => typeof r === "string" && r.length > 0).map((r) => this.normalizeFsPath(r))
          : [];
        const activeFile = typeof data.activeFile === "string" && data.activeFile.length > 0
          ? this.normalizeFsPath(data.activeFile)
          : undefined;
        const key = roots[0] ?? (activeFile ? path.dirname(activeFile) : "");
        if (key) {
          const prev = this.windowStates.get(key);
          this.windowStates.set(key, {
            roots: roots.length > 0 ? roots : prev?.roots ?? [],
            activeFile: activeFile ?? prev?.activeFile,
            updatedAt: Date.now()
          });
        }
      } catch {
        // Ignore malformed payload
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (urlPath === '/mcp' || urlPath.startsWith('/mcp?')) {
      if (req.method === 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Use POST for Streamable HTTP MCP JSON-RPC requests.' }));
        return;
      }
      const rawBody = await this.readBody(req);
      const rpcReq = JSON.parse(rawBody);
      const rpcRes = await this.mcpHandler.handleRpc(rpcReq);
      if (rpcRes === null) {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rpcRes));
      }
      return;
    }

    const target = this.resolveUpstream(urlPath);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Unknown route in Diet Toke proxy: ${urlPath}` }));
      return;
    }

    const rawBody = await this.readBody(req);
    const config = vscode.workspace.getConfiguration('dietToke');
    const enabled = config.get<boolean>('enabled', true);
    const pruneTools = config.get<boolean>('pruneTools', true);
    const injectPromptCache = config.get<boolean>('injectPromptCache', true);

    const requestCwd = this.extractRequestCwd(rawBody, req.headers);
    const { activeFile: resolvedActivePath, workspaceRoot } = this.resolveWindowContext(requestCwd);
    const activeFileBasename = resolvedActivePath ? path.basename(resolvedActivePath) : undefined;
    const currentEditor = vscode.window.activeTextEditor;
    const activeEditor =
      currentEditor && currentEditor.document.uri.scheme === "file" ? currentEditor : this.lastCodeEditor;
    let activeFileCode =
      activeEditor && resolvedActivePath && this.normalizeFsPath(activeEditor.document.fileName) === resolvedActivePath
        ? activeEditor.document.getText()
        : undefined;
    if (!activeFileCode && resolvedActivePath) {
      try {
        activeFileCode = fs.readFileSync(resolvedActivePath, "utf8");
      } catch {}
    }

    const geminiModelMatch = target.rewrittenPath.match(/\/models\/([^/:?]+)/);
    const requestModel = geminiModelMatch ? decodeURIComponent(geminiModelMatch[1]) : undefined;

    const { body: finalBody, savedTokens } = this.compressor.compressApiPayload(
      rawBody,
      {
        enabled,
        pruneTools,
        injectPromptCache,
        activeFileBasename,
        activeFileCode,
        workspaceRoot,
        upstreamHostname: target.hostname,
        upstreamPort: target.port,
        requestModel
      },
      target.isAnthropic
    );

    this.onStatsUpdated();

    const isDefaultPort =
      (target.protocol === 'https:' && target.port === 443) ||
      (target.protocol === 'http:' && target.port === 80);
    const hostHeader = isDefaultPort ? target.hostname : `${target.hostname}:${target.port}`;

    const forwardHeaders: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: hostHeader,
      'accept-encoding': 'identity'
    };
    delete forwardHeaders['content-length'];
    delete forwardHeaders['connection'];

    // Ensure Anthropic prompt-caching beta header is present when cache injection is active
    if (target.isAnthropic && injectPromptCache && !forwardHeaders['anthropic-beta']) {
      forwardHeaders['anthropic-beta'] = 'prompt-caching-2024-07-31';
    }

    const bodyBuffer = Buffer.from(finalBody, 'utf8');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      forwardHeaders['content-length'] = String(bodyBuffer.byteLength);
    }

    const transport = target.protocol === 'http:' ? http : https;
    const proxyReq = transport.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.rewrittenPath,
        method: req.method,
        headers: forwardHeaders
      },
      (proxyRes) => {
        const resHeaders = { ...proxyRes.headers };
        resHeaders["x-diet-toke-saved-tokens"] = String(savedTokens);
        res.writeHead(proxyRes.statusCode ?? 200, resHeaders);

        let tailBuffer = "";
        proxyRes.on("data", (chunk: Buffer) => {
          tailBuffer += chunk.toString("utf8");
          if (tailBuffer.length > 24576) {
            tailBuffer = tailBuffer.slice(-24576);
          }
        });
        proxyRes.on("end", () => {
          const parsed = this.extractUpstreamUsage(tailBuffer);
          if (parsed) {
            this.compressor.recordProviderUsage(parsed);
            this.onStatsUpdated();
          }
        });

        proxyRes.pipe(res);
      }
    );

    proxyReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream provider error', details: err.message }));
      }
    });

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      proxyReq.write(bodyBuffer);
    }
    proxyReq.end();
  }

  private extractUpstreamUsage(rawTail: string): { inputTokens?: number; cachedTokens?: number } | null {
    const candidates: string[] = [];
    const trimmed = rawTail.trim();
    if (trimmed.startsWith("{")) candidates.push(trimmed);
    for (const line of rawTail.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]" && payload.startsWith("{")) {
          candidates.push(payload);
        }
      }
    }
    let inputTokens = 0;
    let cachedTokens = 0;
    for (const jsonStr of candidates) {
      try {
        const obj = JSON.parse(jsonStr) as Record<string, any>;
        const u = obj.usage ?? obj.message?.usage ?? obj.usageMetadata;
        if (!u || typeof u !== "object") continue;
        const inVal = u.prompt_tokens ?? u.input_tokens ?? u.promptTokenCount;
        if (typeof inVal === "number" && inVal > 0) inputTokens = Math.max(inputTokens, inVal);
        const cacheVal =
          u.cache_read_input_tokens ??
          u.prompt_tokens_details?.cached_tokens ??
          u.cachedContentTokenCount;
        if (typeof cacheVal === "number" && cacheVal > 0) cachedTokens = Math.max(cachedTokens, cacheVal);
      } catch {}
    }
    return inputTokens > 0 || cachedTokens > 0 ? { inputTokens, cachedTokens } : null;
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
}