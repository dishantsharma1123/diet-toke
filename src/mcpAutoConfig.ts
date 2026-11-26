import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface SyncOptions {
  port: number;
  globalStorageRoot?: string;
  syncMcpAndProviders: boolean;
  syncRules: boolean;
  syncShellRc: boolean;
}

export interface SyncResult {
  updated: string[];
  clineStateModified: boolean;
}

export class McpAutoConfigurator {
  private readonly didChangeEmitter = new vscode.EventEmitter<void>();
  private static readonly RULE_START = '<!-- DIET-TOKE-START -->';
  private static readonly RULE_END = '<!-- DIET-TOKE-END -->';
  private static readonly SHELL_START = '# >>> DIET-TOKE-START >>>';
  private static readonly SHELL_END = '# <<< DIET-TOKE-END <<<';
  private static readonly TOML_START = '# >>> DIET-TOKE-START >>>';
  private static readonly TOML_END = '# <<< DIET-TOKE-END <<<';

  public registerVsCodeProvider(
    context: vscode.ExtensionContext,
    getPort: () => number
  ): void {
    if (!vscode.lm || typeof vscode.lm.registerMcpServerDefinitionProvider !== 'function') {
      return;
    }

    const provider = vscode.lm.registerMcpServerDefinitionProvider('diet-toke.mcpServer', {
      onDidChangeMcpServerDefinitions: this.didChangeEmitter.event,
      provideMcpServerDefinitions: async () => {
        const port = getPort();
        if (!port) return [];
        return [
          new vscode.McpHttpServerDefinition(
            'Diet Toke',
            vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`)
          )
        ];
      },
      resolveMcpServerDefinition: async (server) => server
    });

    context.subscriptions.push(provider, this.didChangeEmitter);
  }

  public notifyPortChanged(): void {
    this.didChangeEmitter.fire();
  }

  /**
   * Automatically wires up MCP servers, Base URL proxy endpoints, global agent rules,
   * and external shell profiles across all detected coding agents.
   */
  public syncAll(options: SyncOptions): SyncResult {
    const updated: string[] = [];
    let clineStateModified = false;

    if (options.syncMcpAndProviders) {
      updated.push(...this.syncGlobalAgentConfigs(options.port, options.globalStorageRoot));
      const clineUpdated = this.syncClineFamilyProviders(options.port, options.globalStorageRoot);
      updated.push(...clineUpdated);
      clineStateModified = clineUpdated.length > 0;
      updated.push(...this.syncTomlAgents(options.port));
    }

    if (options.syncRules) {
      updated.push(...this.syncGlobalAgentInstructions());
    }

    if (options.syncShellRc) {
      updated.push(...this.syncShellRcFiles(options.port));
    }

    return { updated, clineStateModified };
  }

  /**
   * Restores original provider Base URLs when Diet Toke is paused so agents never break.
   */
  public restoreExternalProxyOverrides(globalStorageRoot?: string): void {
    const home = os.homedir();
    const statePaths = [path.join(home, '.cline', 'data', 'globalState.json')];

    if (globalStorageRoot) {
      statePaths.push(
        path.join(globalStorageRoot, 'saoudrizwan.claude-dev', 'data', 'globalState.json'),
        path.join(globalStorageRoot, 'rooveterinaryinc.roo-cline', 'data', 'globalState.json')
      );
    }

    for (const statePath of statePaths) {
      try {
        if (!fs.existsSync(statePath)) continue;
        const raw = fs.readFileSync(statePath, 'utf8').trim();
        if (!raw) continue;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const backupPath = `${statePath}.diet-toke-backup.json`;
        const backup = fs.existsSync(backupPath)
          ? (JSON.parse(fs.readFileSync(backupPath, 'utf8')) as Record<string, string>)
          : {};

        let changed = false;
        for (const key of ['anthropicBaseUrl', 'openAiBaseUrl', 'geminiBaseUrl']) {
          const val = parsed[key];
          if (typeof val === 'string' && val.startsWith('http://127.0.0.1:')) {
            parsed[key] = backup[key] ?? '';
            changed = true;
          }
        }

        if (changed) {
          fs.writeFileSync(statePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        }
      } catch (err) {
        console.warn(`[Diet Toke] Could not restore ${statePath}:`, err);
      }
    }
  }

  public syncGlobalAgentConfigs(port: number, globalStorageRoot?: string): string[] {
    const home = os.homedir();
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const updatedFiles: string[] = [];
    const allDietTools = [
      'diet_workspace_map',
      'diet_read_relevant',
      'diet_read_skeleton',
      'diet_read_full_file'
    ];

    const targets: Array<{
      filePath: string;
      rootKey?: string;
      entry: Record<string, unknown>;
      createIfMissing: boolean;
    }> = [
      // Claude Code
      {
        filePath: path.join(home, '.claude.json'),
        entry: { type: 'http', url: mcpUrl },
        createIfMissing: true
      },
      // Cursor
      {
        filePath: path.join(home, '.cursor', 'mcp.json'),
        entry: { url: mcpUrl },
        createIfMissing: fs.existsSync(path.join(home, '.cursor'))
      },
      // GitHub Copilot CLI / Global
      {
        filePath: path.join(home, '.copilot', 'mcp-config.json'),
        entry: { type: 'http', url: mcpUrl, tools: ['*'] },
        createIfMissing: fs.existsSync(path.join(home, '.copilot'))
      },
      // Windsurf (Codeium)
      {
        filePath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
        entry: { serverUrl: mcpUrl },
        createIfMissing: fs.existsSync(path.join(home, '.codeium', 'windsurf'))
      },
      // Cline CLI
      {
        filePath: path.join(home, '.cline', 'data', 'settings', 'cline_mcp_settings.json'),
        entry: {
          type: 'streamableHttp',
          url: mcpUrl,
          disabled: false,
          autoApprove: allDietTools
        },
        createIfMissing: fs.existsSync(path.join(home, '.cline'))
      },
      // OpenCode
      {
        filePath: path.join(home, '.config', 'opencode', 'opencode.json'),
        rootKey: 'mcp',
        entry: { type: 'remote', url: mcpUrl, enabled: true },
        createIfMissing: fs.existsSync(path.join(home, '.config', 'opencode'))
      }
    ];

    // Cross-platform VS Code / Cursor / Windsurf globalStorage for Cline, Roo Code, and Kilo Code
    if (globalStorageRoot) {
      const vsCodeAgentExtensions = [
        { extId: 'saoudrizwan.claude-dev', settingsFile: 'cline_mcp_settings.json' },
        { extId: 'rooveterinaryinc.roo-cline', settingsFile: 'mcp_settings.json' },
        { extId: 'kilocode.kilo-code', settingsFile: 'mcp_settings.json' }
      ];

      for (const ext of vsCodeAgentExtensions) {
        const extDir = path.join(globalStorageRoot, ext.extId);
        targets.push({
          filePath: path.join(extDir, 'settings', ext.settingsFile),
          entry: {
            type: 'streamableHttp',
            url: mcpUrl,
            disabled: false,
            autoApprove: allDietTools
          },
          createIfMissing: fs.existsSync(extDir)
        });
      }
    }

    for (const target of targets) {
      try {
        const exists = fs.existsSync(target.filePath);
        if (!exists && !target.createIfMissing) continue;

        let parsed: Record<string, unknown> = {};
        if (exists) {
          const raw = fs.readFileSync(target.filePath, 'utf8').trim();
          if (raw) parsed = JSON.parse(raw);
        } else {
          fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
        }

        const containerKey = target.rootKey ?? 'mcpServers';
        const servers =
          typeof parsed[containerKey] === 'object' && parsed[containerKey] !== null
            ? (parsed[containerKey] as Record<string, unknown>)
            : {};

        servers['diet-toke'] = target.entry;
        parsed[containerKey] = servers;

        fs.writeFileSync(target.filePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
        updatedFiles.push(target.filePath);
      } catch (err) {
        console.warn(`[Diet Toke] Could not update ${target.filePath}:`, err);
      }
    }

    return updatedFiles;
  }

  /**
   * Automatically routes Cline and Roo Code API traffic through Diet Toke's local proxy
   * while preserving any custom user-defined URLs in a backup file.
   */
  private syncClineFamilyProviders(port: number, globalStorageRoot?: string): string[] {
    const home = os.homedir();
    const updated: string[] = [];
    const statePaths = [path.join(home, '.cline', 'data', 'globalState.json')];

    if (globalStorageRoot) {
      statePaths.push(
        path.join(globalStorageRoot, 'saoudrizwan.claude-dev', 'data', 'globalState.json'),
        path.join(globalStorageRoot, 'rooveterinaryinc.roo-cline', 'data', 'globalState.json')
      );
    }

    const defaultDesiredUrls: Record<string, string> = {
      anthropicBaseUrl: `http://127.0.0.1:${port}/anthropic`,
      openAiBaseUrl: `http://127.0.0.1:${port}/openai/v1`,
      geminiBaseUrl: `http://127.0.0.1:${port}/gemini`
    };

    for (const statePath of statePaths) {
      try {
        if (!fs.existsSync(statePath)) continue;
        const raw = fs.readFileSync(statePath, 'utf8').trim();
        if (!raw) continue;

        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const backupPath = `${statePath}.diet-toke-backup.json`;
        const backup: Record<string, string> = fs.existsSync(backupPath)
          ? (JSON.parse(fs.readFileSync(backupPath, 'utf8')) as Record<string, string>)
          : {};

        let backupChanged = false;
        let stateChanged = false;

        for (const [key, defaultUrl] of Object.entries(defaultDesiredUrls)) {
          const currentVal = parsed[key];
          if (
            typeof currentVal === 'string' &&
            currentVal.trim() !== '' &&
            !currentVal.startsWith('http://127.0.0.1:')
          ) {
            backup[key] = currentVal.trim();
            backupChanged = true;
          }

          const customUpstream = backup[key]?.trim();
          const targetUrl = customUpstream
            ? `http://127.0.0.1:${port}/proxy/${Buffer.from(
                customUpstream.replace(/\/+$/, ''),
                'utf8'
              ).toString('base64url')}`
            : defaultUrl;

          if (parsed[key] !== targetUrl) {
            parsed[key] = targetUrl;
            stateChanged = true;
          }
        }

        if (backupChanged) {
          fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2) + '\n', 'utf8');
        }
        if (stateChanged) {
          fs.writeFileSync(statePath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
          updated.push(statePath);
        }
      } catch (err) {
        console.warn(`[Diet Toke] Could not configure provider routing in ${statePath}:`, err);
      }
    }

    return updated;
  }

  /**
   * Registers Diet Toke MCP server in TOML-based CLI agents such as OpenAI Codex CLI (~/.codex/config.toml).
   */
  private syncTomlAgents(port: number): string[] {
    const codexConfig = path.join(os.homedir(), '.codex', 'config.toml');
    if (!fs.existsSync(codexConfig)) return [];

    try {
      const current = fs.readFileSync(codexConfig, 'utf8');
      const block = [
        McpAutoConfigurator.TOML_START,
        '[mcp_servers.diet-toke]',
        `url = "http://127.0.0.1:${port}/mcp"`,
        McpAutoConfigurator.TOML_END
      ].join('\n');

      const regex = new RegExp(
        `${McpAutoConfigurator.TOML_START}[\\s\\S]*?${McpAutoConfigurator.TOML_END}`,
        'g'
      );
      const next = regex.test(current)
        ? current.replace(regex, block)
        : `${current.trimEnd()}\n\n${block}\n`;

      if (next !== current) {
        fs.writeFileSync(codexConfig, next, 'utf8');
      }
      return [codexConfig];
    } catch (err) {
      console.warn('[Diet Toke] Could not update Codex config.toml:', err);
      return [];
    }
  }

  private getAgentInstructionBlock(): string {
    return [
      McpAutoConfigurator.RULE_START,
      '## Token-Efficient Code Reading (Diet Toke MCP)',
      'Always prioritize `diet-toke` MCP tools before calling built-in full-file read tools:',
      '1. Call `diet_workspace_map` first to discover files and exported symbols.',
      '2. Call `diet_read_relevant` when inspecting dependencies imported by the active file.',
      '3. Call `diet_read_skeleton` to inspect types, interfaces, and signatures without reading full function bodies.',
      '4. Only call `diet_read_full_file` (or built-in full read) on the specific file or line range you are actively editing.',
      McpAutoConfigurator.RULE_END
    ].join('\n');
  }

  /**
   * Idempotently injects Diet Toke tool-preference rules into global agent instruction files
   * across Claude Code, Copilot, Cline, Roo Code, Windsurf, and Cursor.
   */
  public syncGlobalAgentInstructions(): string[] {
    const home = os.homedir();
    const block = this.getAgentInstructionBlock();
    const updated: string[] = [];

    const markdownTargets: Array<{ filePath: string; createIfMissing: boolean }> = [
      {
        filePath: path.join(home, '.claude', 'CLAUDE.md'),
        createIfMissing: true
      },
      {
        filePath: path.join(home, '.copilot', 'copilot-instructions.md'),
        createIfMissing: true
      },
      {
        filePath: path.join(home, '.cline', 'rules', 'diet-toke.md'),
        createIfMissing: fs.existsSync(path.join(home, '.cline'))
      },
      {
        filePath: path.join(home, 'Documents', 'Cline', 'Rules', 'diet-toke.md'),
        createIfMissing: fs.existsSync(path.join(home, 'Documents', 'Cline'))
      },
      {
        filePath: path.join(home, '.roo', 'rules', 'diet-toke.md'),
        createIfMissing: fs.existsSync(path.join(home, '.roo'))
      },
      {
        filePath: path.join(home, '.windsurf', 'rules', 'diet-toke.md'),
        createIfMissing: fs.existsSync(path.join(home, '.windsurf'))
      }
    ];

    for (const target of markdownTargets) {
      try {
        const exists = fs.existsSync(target.filePath);
        if (!exists && !target.createIfMissing) continue;

        if (!exists) {
          fs.mkdirSync(path.dirname(target.filePath), { recursive: true });
          fs.writeFileSync(target.filePath, block + '\n', 'utf8');
          updated.push(target.filePath);
          continue;
        }

        const current = fs.readFileSync(target.filePath, 'utf8');
        const markerRegex = new RegExp(
          `${McpAutoConfigurator.RULE_START}[\\s\\S]*?${McpAutoConfigurator.RULE_END}`,
          'g'
        );

        const nextContent = markerRegex.test(current)
          ? current.replace(markerRegex, block)
          : `${current.trimEnd()}\n\n${block}\n`;

        if (nextContent !== current) {
          fs.writeFileSync(target.filePath, nextContent, 'utf8');
        }
        updated.push(target.filePath);
      } catch (err) {
        console.warn(`[Diet Toke] Could not update ${target.filePath}:`, err);
      }
    }

    const cursorDir = path.join(home, '.cursor');
    if (fs.existsSync(cursorDir)) {
      try {
        const cursorRulePath = path.join(cursorDir, 'rules', 'diet-toke.mdc');
        fs.mkdirSync(path.dirname(cursorRulePath), { recursive: true });
        const mdcContent = `---\ndescription: Prioritize Diet Toke MCP tools to minimize token usage\nalwaysApply: true\n---\n\n${block}\n`;
        fs.writeFileSync(cursorRulePath, mdcContent, 'utf8');
        updated.push(cursorRulePath);
      } catch (err) {
        console.warn('[Diet Toke] Could not write Cursor rule:', err);
      }
    }

    return updated;
  }

  /**
   * Adds a safe, port-checked proxy block to ~/.zshrc and ~/.bashrc so standalone terminals
   * (iTerm2, Terminal.app, Warp) automatically route through Diet Toke while VS Code is open.
   */
  public syncShellRcFiles(port: number): string[] {
    if (process.platform === 'win32') return [];
    const home = os.homedir();
    const updated: string[] = [];

    const block = [
      McpAutoConfigurator.SHELL_START,
      `if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 ${port} >/dev/null 2>&1; then`,
      `  export OPENAI_BASE_URL="http://127.0.0.1:${port}/openai/v1"`,
      `  export OPENAI_API_BASE="http://127.0.0.1:${port}/openai/v1"`,
      `  export ANTHROPIC_BASE_URL="http://127.0.0.1:${port}/anthropic"`,
      `  export GEMINI_BASE_URL="http://127.0.0.1:${port}/gemini"`,
      'fi',
      McpAutoConfigurator.SHELL_END
    ].join('\n');

    const rcFiles = [path.join(home, '.zshrc'), path.join(home, '.bashrc')];
    for (const rcPath of rcFiles) {
      try {
        if (!fs.existsSync(rcPath)) continue;
        const current = fs.readFileSync(rcPath, 'utf8');
        const regex = new RegExp(
          `${McpAutoConfigurator.SHELL_START}[\\s\\S]*?${McpAutoConfigurator.SHELL_END}`,
          'g'
        );
        const next = regex.test(current)
          ? current.replace(regex, block)
          : `${current.trimEnd()}\n\n${block}\n`;

        if (next !== current) {
          fs.writeFileSync(rcPath, next, 'utf8');
        }
        updated.push(rcPath);
      } catch (err) {
        console.warn(`[Diet Toke] Could not update ${rcPath}:`, err);
      }
    }

    return updated;
  }
}