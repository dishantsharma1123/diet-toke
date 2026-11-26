import * as http from 'http';
import * as path from 'path';
import * as vscode from 'vscode';
import { LifetimeStats, TokenCompressor } from './compressor';
import { McpAutoConfigurator } from './mcpAutoConfig';
import { DietMcpHandler } from './mcpServer';
import { DietProxyServer } from './proxyServer';
import { DashboardPanel } from './dashboardPanel';

let proxyServer: DietProxyServer | null = null;

function fetchPrimaryProxyStats(
  port: number
): Promise<{ alive: boolean; stats?: TokenCompressor['stats'] }> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 400 }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += String(chunk);
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body) as {
            status?: string;
            stats?: TokenCompressor['stats'];
          };
          if (res.statusCode === 200 && parsed.status === 'ok') {
            resolve({ alive: true, stats: parsed.stats });
          } else {
            resolve({ alive: false });
          }
        } catch {
          resolve({ alive: false });
        }
      });
    });
    req.on('error', () => resolve({ alive: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ alive: false });
    });
  });
}

function resetPrimaryProxy(
  port: number,
  scope: 'session' | 'lifetime' | 'cache'
): Promise<{ ok: boolean; stats?: TokenCompressor['stats'] }> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/reset?scope=${scope}`,
        method: 'POST',
        timeout: 600
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += String(chunk);
        });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(body) as { stats?: TokenCompressor['stats'] };
              resolve({ ok: true, stats: parsed.stats });
              return;
            } catch {
              resolve({ ok: true });
              return;
            }
          }
          resolve({ ok: false });
        });
      }
    );
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.end();
  });
}

function registerWorkspaceWithProxy(port: number): void {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const editor = vscode.window.activeTextEditor;
  const activeFile = editor && editor.document.uri.scheme === 'file' ? editor.document.fileName : undefined;
  if (roots.length === 0 && !activeFile) return;

  const payload = JSON.stringify({ roots, activeFile });
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/register-workspace',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    },
    timeout: 400
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.write(payload);
  req.end();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const compressor = new TokenCompressor();
  compressor.loadLifetimeStats(
    context.globalState.get<LifetimeStats>('dietToke.lifetimeStats')
  );
  const mcpHandler = new DietMcpHandler(compressor, () => proxyServer?.getRegisteredRoots() ?? []);
  const mcpConfig = new McpAutoConfigurator();

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'dietToke.openDashboard';
  statusBar.text = "$(pulse) Diet Toke";
  statusBar.show();
  context.subscriptions.push(statusBar);

  const config = vscode.workspace.getConfiguration('dietToke');
  const preferredPort = config.get<number>('port', 48192);
  let activePort = preferredPort;

  const updateStatusBar = () => {
    const enabled = vscode.workspace.getConfiguration('dietToke').get<boolean>('enabled', true);
    const { originalTokens, compressedTokens } = compressor.stats;
    const saved = Math.max(0, originalTokens - compressedTokens);
    const pct = originalTokens > 0 ? Math.round((saved / originalTokens) * 100) : 0;
    const currentPort = proxyServer?.activePort || activePort;

    const lifeSaved = Math.max(
      0,
      compressor.stats.lifetime.originalTokens - compressor.stats.lifetime.compressedTokens
    );

    if (!enabled) {
      statusBar.text = '$(circle-slash) Diet Toke: Paused';
      statusBar.tooltip = `Diet Toke is paused (Lifetime saved: ${lifeSaved.toLocaleString()} tokens). Click for Dashboard.`;
    } else {
      const savedLabel = saved >= 1000 ? `${(saved / 1000).toFixed(1)}k` : `${saved}`;
      statusBar.text = `$(pulse) Diet Toke: -${pct}% (${savedLabel} saved)`;
      statusBar.tooltip = `Diet Toke (Port ${currentPort}) — Session: ${saved.toLocaleString()} | Lifetime: ${lifeSaved.toLocaleString()} tokens saved`;
    }
    statusBar.show();
    if (proxyServer?.activePort) {
      void context.globalState.update('dietToke.lifetimeStats', compressor.stats.lifetime);
    }
    DashboardPanel.updateIfVisible(compressor.stats, enabled, currentPort);
  };

  proxyServer = new DietProxyServer(compressor, mcpHandler, updateStatusBar);

  const initialHealth = await fetchPrimaryProxyStats(preferredPort);
  if (!initialHealth.alive) {
    activePort = await proxyServer.start(preferredPort);
  } else if (initialHealth.stats) {
    compressor.stats = initialHealth.stats;
  }

  // Sync live stats from primary window or take over preferredPort immediately if primary closes
  const watchdog = setInterval(async () => {
    if (proxyServer && !proxyServer.activePort) {
      const health = await fetchPrimaryProxyStats(preferredPort);
      if (!health.alive) {
        activePort = await proxyServer.start(preferredPort);
        mcpConfig.notifyPortChanged();
        updateStatusBar();
      } else if (
        health.stats &&
        (health.stats.requestsProcessed !== compressor.stats.requestsProcessed ||
          health.stats.originalTokens !== compressor.stats.originalTokens ||
          health.stats.lifetime.requestsProcessed !== compressor.stats.lifetime.requestsProcessed ||
          health.stats.lifetime.originalTokens !== compressor.stats.lifetime.originalTokens)
      ) {
        compressor.stats = health.stats;
        updateStatusBar();
      }
    }
  }, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(watchdog) });

  const port = activePort;

  registerWorkspaceWithProxy(preferredPort);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => registerWorkspaceWithProxy(preferredPort)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => registerWorkspaceWithProxy(preferredPort))
  );

  // Technique 1: Auto-inject global environment variables into all VS Code terminals
  let baseUrl = `http://127.0.0.1:${port}`;
  try {
    const forwarded = await vscode.env.asExternalUri(vscode.Uri.parse(baseUrl));
    baseUrl = forwarded.toString().replace(/\/+$/, "");
  } catch {}
  context.environmentVariableCollection.persistent = true;
  context.environmentVariableCollection.replace('OPENAI_BASE_URL', `${baseUrl}/openai/v1`);
  context.environmentVariableCollection.replace('OPENAI_API_BASE', `${baseUrl}/openai/v1`);
  context.environmentVariableCollection.replace('ANTHROPIC_BASE_URL', `${baseUrl}/anthropic`);
  context.environmentVariableCollection.replace('GEMINI_BASE_URL', `${baseUrl}/gemini`);

  const globalStorageRoot = path.dirname(context.globalStorageUri.fsPath);
  const runFullAutoSync = async (): Promise<string[]> => {
    const cfg = vscode.workspace.getConfiguration('dietToke');
    const portToUse = proxyServer?.activePort || activePort;
    const result = mcpConfig.syncAll({
      port: portToUse,
      globalStorageRoot,
      syncMcpAndProviders: cfg.get<boolean>('autoSyncGlobalMcp', true),
      syncRules: cfg.get<boolean>('autoSyncAgentRules', true),
      syncShellRc: cfg.get<boolean>('autoConfigureShellRc', true)
    });

    // Automatically refresh Extension Host once if Cline/Roo's cached Base URL was healed
    const clineActive =
      vscode.extensions.getExtension('saoudrizwan.claude-dev')?.isActive ||
      vscode.extensions.getExtension('rooveterinaryinc.roo-cline')?.isActive ||
      vscode.extensions.getExtension('kilocode.kilo-code')?.isActive;

    if (result.clineStateModified && clineActive) {
      const lastRestart = context.globalState.get<number>('dietToke.lastHostRestart', 0);
      if (Date.now() - lastRestart > 60_000) {
        await context.globalState.update('dietToke.lastHostRestart', Date.now());
        void vscode.commands.executeCommand('workbench.action.restartExtensionHost');
      }
    }

    return result.updated;
  };

  // Technique 3: Register native VS Code MCP provider & auto-wire all installed coding agents
  mcpConfig.registerVsCodeProvider(context, () => proxyServer?.activePort || activePort);
  if (config.get<boolean>('enabled', true)) {
    await runFullAutoSync();
  }

  // Re-sync automatically if the user installs another coding agent (Cline, Roo, Copilot, etc.)
  context.subscriptions.push(
    vscode.extensions.onDidChange(() => {
      if (vscode.workspace.getConfiguration('dietToke').get<boolean>('enabled', true)) {
        void runFullAutoSync();
        mcpConfig.notifyPortChanged();
      }
    })
  );

  // Automatically reset session counters when opening or switching workspaces
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      compressor.resetStats();
      compressor.resetCache();
      updateStatusBar();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('dietToke.enabled')) {
        updateStatusBar();
      }
    })
  );

  updateStatusBar();

  context.subscriptions.push(
    vscode.commands.registerCommand('dietToke.toggle', async () => {
      const cfg = vscode.workspace.getConfiguration('dietToke');
      const nextEnabled = !cfg.get<boolean>('enabled', true);
      await cfg.update('enabled', nextEnabled, vscode.ConfigurationTarget.Global);
      if (nextEnabled) {
        await runFullAutoSync();
      } else {
        mcpConfig.restoreExternalProxyOverrides(globalStorageRoot);
      }
      updateStatusBar();
      vscode.window.showInformationMessage(
        `Diet Toke compression ${nextEnabled ? 'enabled' : 'paused'}.`
      );
    }),

    vscode.commands.registerCommand('dietToke.copyEnv', async () => {
      const exportsText = [
        `export OPENAI_BASE_URL="${baseUrl}/openai/v1"`,
        `export OPENAI_API_BASE="${baseUrl}/openai/v1"`,
        `export ANTHROPIC_BASE_URL="${baseUrl}/anthropic"`,
        `export GEMINI_BASE_URL="${baseUrl}/gemini"`
      ].join('\n');
      await vscode.env.clipboard.writeText(exportsText);
      vscode.window.showInformationMessage(
        'Copied Diet Toke environment exports to clipboard for external shells!'
      );
    }),

    vscode.commands.registerCommand('dietToke.syncMcp', async () => {
      const allSynced = await runFullAutoSync();
      mcpConfig.notifyPortChanged();
      vscode.window.showInformationMessage(
        allSynced.length > 0
          ? `Auto-configured Diet Toke across ${allSynced.length} agent/shell targets.`
          : 'VS Code native MCP provider is active.'
      );
    }),

    vscode.commands.registerCommand('dietToke.resetStats', async () => {
      if (proxyServer && !proxyServer.activePort) {
        const res = await resetPrimaryProxy(preferredPort, 'session');
        if (!res.ok) {
          vscode.window.showWarningMessage(
            `Diet Toke: Reload your other VS Code window so port ${preferredPort} supports remote reset.`
          );
          return;
        }
        if (res.stats) compressor.stats = res.stats;
      }
      compressor.resetStats();
      updateStatusBar();
      vscode.window.showInformationMessage('Diet Toke session token stats reset to 0.');
    }),

    vscode.commands.registerCommand('dietToke.resetLifetimeStats', async () => {
      if (proxyServer && !proxyServer.activePort) {
        const res = await resetPrimaryProxy(preferredPort, 'lifetime');
        if (!res.ok) {
          vscode.window.showWarningMessage(
            `Diet Toke: Reload your other VS Code window so port ${preferredPort} supports remote reset.`
          );
          return;
        }
        if (res.stats) compressor.stats = res.stats;
      }
      compressor.resetLifetimeStats();
      await context.globalState.update('dietToke.lifetimeStats', compressor.stats.lifetime);
      updateStatusBar();
      vscode.window.showInformationMessage('Diet Toke lifetime token stats reset to 0.');
    }),

    vscode.commands.registerCommand('dietToke.resetCache', async () => {
      if (proxyServer && !proxyServer.activePort) {
        const res = await resetPrimaryProxy(preferredPort, 'cache');
        if (!res.ok) {
          vscode.window.showWarningMessage(
            `Diet Toke: Reload your other VS Code window so port ${preferredPort} supports remote reset.`
          );
          return;
        }
      }
      compressor.resetCache();
      vscode.window.showInformationMessage('Diet Toke deduplication cache cleared.');
    }),

    vscode.commands.registerCommand('dietToke.showStats', () => {
      const { requestsProcessed, originalTokens, compressedTokens, cacheEligibleTokens } =
        compressor.stats;
      const saved = Math.max(0, originalTokens - compressedTokens);
      const pct = originalTokens > 0 ? ((saved / originalTokens) * 100).toFixed(1) : '0.0';
      vscode.window.showInformationMessage(
        `Diet Toke (Port ${port}) — Requests: ${requestsProcessed} | Original: ~${originalTokens} | Sent: ~${compressedTokens} | Saved: ~${saved} (${pct}%) | Cache-Eligible: ~${cacheEligibleTokens}`
      );
    }),

    vscode.commands.registerCommand('dietToke.openDashboard', async () => {
      const enabled = vscode.workspace.getConfiguration('dietToke').get<boolean>('enabled', true);
      if (proxyServer && !proxyServer.activePort) {
        const health = await fetchPrimaryProxyStats(preferredPort);
        if (health.alive && health.stats) {
          compressor.stats = health.stats;
          updateStatusBar();
        }
      }
      DashboardPanel.createOrShow(compressor.stats, enabled, proxyServer?.activePort || activePort);
    })
  );
}

export function deactivate(): void {
  if (proxyServer) {
    proxyServer.stop();
    proxyServer = null;
  }
}