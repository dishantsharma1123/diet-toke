import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { CompressionStats } from './compressor';

export class DashboardPanel {
  public static currentPanel: DashboardPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: { command?: string }) => {
        switch (message.command) {
          case 'toggle':
            await vscode.commands.executeCommand('dietToke.toggle');
            break;
          case 'syncMcp':
            await vscode.commands.executeCommand('dietToke.syncMcp');
            break;
          case 'resetStats':
            await vscode.commands.executeCommand('dietToke.resetStats');
            break;
          case 'resetLifetime':
            await vscode.commands.executeCommand('dietToke.resetLifetimeStats');
            break;
          case 'resetCache':
            await vscode.commands.executeCommand('dietToke.resetCache');
            break;
        }
      },
      null,
      this.disposables
    );
  }

  public static createOrShow(stats: CompressionStats, enabled: boolean, port: number): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.panel.reveal(column);
      DashboardPanel.currentPanel.update(stats, enabled, port);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dietTokeDashboard',
      'Diet Toke Analytics',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    DashboardPanel.currentPanel = new DashboardPanel(panel);
    DashboardPanel.currentPanel.update(stats, enabled, port);
  }

  public static updateIfVisible(stats: CompressionStats, enabled: boolean, port: number): void {
    if (DashboardPanel.currentPanel) {
      DashboardPanel.currentPanel.update(stats, enabled, port);
    }
  }

  public update(stats: CompressionStats, enabled: boolean, port: number): void {
    this.panel.webview.html = this.getHtml(stats, enabled, port);
  }

  private getHtml(stats: CompressionStats, enabled: boolean, port: number): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const saved = Math.max(0, stats.originalTokens - stats.compressedTokens);
    const pct = stats.originalTokens > 0 ? ((saved / stats.originalTokens) * 100).toFixed(1) : '0.0';

    const totalUsd = (stats.costSavedUsd ?? 0).toFixed(4);
    const lifeSaved = Math.max(0, stats.lifetime.originalTokens - stats.lifetime.compressedTokens);
    const lifeUsd = (stats.lifetime.costSavedUsd ?? 0).toFixed(4);
    const activeModelTag = stats.lastModel
      ? stats.lastProviderLocal
        ? `Model: <strong>${stats.lastModel}</strong> (Local &bull; $0.00 rate)`
        : `Model: <strong>${stats.lastModel}</strong>`
      : "";

    const layers = [
      {
        label: '1-Hop Import Slicing & Skeletonization',
        tokens: stats.savedByLayer.slicingAndSkeleton,
        color: '#3b82f6'
      },
      {
        label: 'Dynamic Tool / MCP Schema Pruning',
        tokens: stats.savedByLayer.toolPruning,
        color: '#8b5cf6'
      },
      {
        label: 'Terminal & Test Log Distillation',
        tokens: stats.savedByLayer.logDistillation,
        color: '#10b981'
      },
      {
        label: 'History Compaction & SHA-256 Dedup',
        tokens: stats.savedByLayer.historyAndDedup,
        color: '#f59e0b'
      }
    ];

    const maxLayerTokens = Math.max(1, ...layers.map((l) => l.tokens));

    const layerRows = layers
      .map((l) => {
        const widthPct = Math.min(100, Math.round((l.tokens / maxLayerTokens) * 100));
        return `
          <div class="layer-row">
            <div class="layer-header">
              <span>${l.label}</span>
              <strong>${l.tokens.toLocaleString()} tokens</strong>
            </div>
            <div class="bar-bg">
              <div class="bar-fill" style="width: ${widthPct}%; background: ${l.color};"></div>
            </div>
          </div>`;
      })
      .join('');

    const recentRows =
      stats.recentRequests.length === 0
        ? `<tr><td colspan="6" class="empty">No proxied requests recorded yet in this session.</td></tr>`
        : [...stats.recentRequests]
            .reverse()
            .map((r) => {
              const rPct =
                r.originalTokens > 0
                  ? Math.round((r.savedTokens / r.originalTokens) * 100)
                  : 0;
              const billedNote = r.providerInputTokens ? ` <span style="opacity:.65">(${r.providerInputTokens.toLocaleString()} billed)</span>` : "";
              const usdLabel = r.isLocal ? "$0.0000 (local)" : `${(r.costSavedUsd ?? 0).toFixed(4)}`;
              return `
                <tr>
                  <td>${r.timestamp}</td>
                  <td><span class="badge">${r.source}</span>${r.model ? ` <span class="badge">${r.model}</span>` : ""}</td>
                  <td>${r.originalTokens.toLocaleString()}</td>
                  <td>${r.compressedTokens.toLocaleString()}${billedNote}</td>
                  <td class="pos">-${r.savedTokens.toLocaleString()} (${rPct}%)</td>
                  <td>${usdLabel}</td>
                </tr>`;
            })
            .join("");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Diet Toke Analytics</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 24px;
      max-width: 920px;
      margin: 0 auto;
    }
    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 20px;
      flex-wrap: wrap;
      gap: 12px;
    }
    h1 { margin: 0; font-size: 20px; }
    .subtitle { opacity: 0.75; font-size: 12px; margin-top: 4px; }
    .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
      gap: 12px;
      margin-bottom: 24px;
    }
    .card {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 14px 16px;
    }
    .card-label { font-size: 11px; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.5px; }
    .card-value { font-size: 24px; font-weight: 700; margin-top: 6px; }
    .card-sub { font-size: 11px; opacity: 0.7; margin-top: 4px; }
    .section {
      background: var(--vscode-sideBar-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      padding: 16px;
      margin-bottom: 20px;
    }
    .section h2 { margin: 0 0 14px 0; font-size: 14px; }
    .layer-row { margin-bottom: 12px; }
    .layer-row:last-child { margin-bottom: 0; }
    .layer-header { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; }
    .bar-bg {
      height: 8px;
      background: var(--vscode-editor-background);
      border-radius: 4px;
      overflow: hidden;
    }
    .bar-fill { height: 100%; border-radius: 4px; transition: width 0.25s ease; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    th { opacity: 0.75; font-weight: 600; }
    .pos { color: #10b981; font-weight: 600; }
    .badge {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
    }
    .empty { text-align: center; opacity: 0.65; padding: 18px; }
  </style>
</head>
<body>
  <div class="top-bar">
    <div>
      <h1>Diet Toke — Live Token Analytics</h1>
      <div class="subtitle">Status: <strong>${enabled ? 'Active' : 'Paused'}</strong> &bull; Local Proxy &amp; MCP Port: <strong>${port}</strong>${activeModelTag ? ` &bull; ${activeModelTag}` : ""}</div>
    </div>
    <div class="actions">
      <button data-cmd="toggle">${enabled ? 'Pause Compression' : 'Resume Compression'}</button>
      <button class="secondary" data-cmd="syncMcp">Sync MCP &amp; Rules</button>
      <button class="secondary" data-cmd="resetCache">Clear Dedup Cache</button>
      <button class="secondary" data-cmd="resetStats">Reset Session</button>
      <button class="secondary" data-cmd="resetLifetime">Reset Lifetime</button>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <div class="card-label">Session Saved</div>
      <div class="card-value">${saved.toLocaleString()}</div>
      <div class="card-sub">${stats.originalTokens.toLocaleString()} raw &rarr; ${stats.compressedTokens.toLocaleString()} sent</div>
    </div>
    <div class="card">
      <div class="card-label">Reduction Rate</div>
      <div class="card-value">-${pct}%</div>
      <div class="card-sub">Across ${stats.requestsProcessed} session requests</div>
    </div>
    <div class="card">
      <div class="card-label">Session Cost Saved</div>
      <div class="card-value">$${totalUsd}</div>
      <div class="card-sub">${stats.lastProviderLocal ? "Local provider ($0.00/1M)" : "Model-aware input + cache rates"}</div>
    </div>
    <div class="card">
      <div class="card-label">Cache-Eligible</div>
      <div class="card-value">${stats.cacheEligibleTokens.toLocaleString()}</div>
      <div class="card-sub">${stats.providerInputTokens > 0 ? `Billed: ${stats.providerInputTokens.toLocaleString()} in &bull; ${stats.providerCachedTokens.toLocaleString()} cached` : "Prefix-cached input tokens"}</div>
    </div>
    <div class="card">
      <div class="card-label">Lifetime Saved</div>
      <div class="card-value">${lifeSaved.toLocaleString()}</div>
      <div class="card-sub">$${lifeUsd} saved (${stats.lifetime.requestsProcessed} reqs)</div>
    </div>
  </div>

  <div class="section">
    <h2>Savings Breakdown by Compression Layer</h2>
    ${layerRows}
  </div>

  <div class="section">
    <h2>Recent Requests</h2>
    <table>
      <thead>
        <tr>
          <th>Time</th>
          <th>Channel</th>
          <th>Original</th>
          <th>Sent</th>
          <th>Saved</th>
          <th>Cost Saved</th>
        </tr>
      </thead>
      <tbody>
        ${recentRows}
      </tbody>
    </table>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('button[data-cmd]').forEach((btn) => {
      btn.addEventListener('click', () => {
        vscode.postMessage({ command: btn.getAttribute('data-cmd') });
      });
    });
  </script>
</body>
</html>`;
  }

  public dispose(): void {
    DashboardPanel.currentPanel = undefined;
    this.panel.dispose();
    while (this.disposables.length) {
      const d = this.disposables.pop();
      if (d) d.dispose();
    }
  }
}