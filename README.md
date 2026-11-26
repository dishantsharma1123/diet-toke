# Diet Toke (`v1.1.0`)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/dishantsharma1123.diet-toke?label=VS%20Code%20Marketplace&logo=visual-studio-code)](https://marketplace.visualstudio.com/items?itemName=dishantsharma1123.diet-toke) [![VS Code Marketplace Installs](https://img.shields.io/visual-studio-marketplace/i/dishantsharma1123.diet-toke?label=Installs)](https://marketplace.visualstudio.com/items?itemName=dishantsharma1123.diet-toke)

**Full-payload token compression, TypeScript Compiler AST skeletonization, and live cost analytics for AI coding agents in VS Code.**

Diet Toke sits transparently between your VS Code AI coding agent (**Cline**, **Roo Code**, **Continue**) and your LLM provider as a zero-dependency local HTTP proxy (`127.0.0.1:48192`) and Model Context Protocol (MCP) server. It compacts repetitive system prompts, verbose tool schemas, file reads, terminal logs, and multi-turn conversation history—cutting **65.0% of total session input tokens** (and up to **77.6%** on multi-turn requests) while keeping active target files intact during edits.

---

## Measured Benchmark (`v1.1.0`)

Benchmarked across multi-turn repository analysis sessions in Cline (`gpt-6-astra`, `128k` context window):

| Metric | Uncompressed Raw | With Diet Toke `v1.1.0` | Net Reduction |
| :--- | :---: | :---: | :---: |
| **Total Session Input Tokens (6 Requests)** | `54,123` | **`18,968`** | **`-65.0%` (`35,155` saved)** |
| **Peak Single-Turn Payload** | `14,296` | **`3,198`** | **`-77.6%` (`11,098` saved)** |
| **History Compaction & SHA-256 Dedup** | — | — | `20,076` tokens |
| **Dynamic Tool & MCP Schema Pruning** | — | — | `10,452` tokens |
| **AST & 1-Hop Import Slicing** | — | — | `4,629` tokens |

---

## Key Capabilities

### 1. Multi-Protocol Local Proxy (`127.0.0.1:48192`)
* **OpenAI, Anthropic & Native Gemini Support:** Intercepts and compresses `/chat/completions`, `/v1/messages`, and native Gemini `:generateContent` / `:streamGenerateContent` payloads (including SSE streams).
* **Multi-Window Workspace Isolation:** Routes concurrent VS Code windows through a single shared proxy port (`48192`) using isolated per-workspace state (`Map<root, WindowState>`), preventing cross-project file or symbol collisions.
* **Remote-Ready Lifecycle:** Automatically forwards port `48192` via `vscode.env.asExternalUri` in Remote SSH, WSL, and GitHub Codespaces, and guards shell RC exports with `nc -z` liveness checks so disconnected terminals never break API calls.

### 2. Compiler AST & Multi-Language Skeletonizer (`src/astSkeletonizer.ts`)
* **TypeScript & JavaScript Compiler AST (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`):** Uses `ts.createSourceFile()` span editing to replace function, method, constructor, and accessor bodies with `{ ... }`, remove `private` and `#private` members, and condense JSDoc comments to their summary line—immune to regex literals or nested template braces.
* **Multi-Language Compactors:** Structural skeletonization for **Ruby**, **HTML/XML/SVG**, **SQL**, **YAML**, and **Shell** scripts.
* **Intent-Aware Edit Guard:** Automatically classifies every prompt (`read-only` vs. `edit`):
  * **`read-only` mode:** Aggressively skeletonizes target files, dependencies, and Turn-1 `<file_content>` / MCP file reads.
  * **`edit` mode:** Preserves active target files 100% verbatim so patches and diffs never fail, while still skeletonizing surrounding dependencies.

### 3. Dynamic Tool Pruning, History Folding & Cache Stability
* **Schema & Property Compaction:** Strips write and shell-execution tool definitions during `read-only` tasks and trims verbose tool and `parameters.properties` descriptions while keeping `type`, `enum`, and `required` fields intact.
* **4-Turn Active Window Folding:** Folds older intermediate turns into concise action summaries once a session exceeds 6 messages, while preserving `messages[0..1]` byte-for-byte to keep upstream KV prefix caches warm.
* **SHA-256 Block Deduplication:** Replaces repeated file contents and code blocks across turns with lightweight back-references.

### 4. MCP Server & Live Token Analytics Dashboard
* **Built-In MCP Endpoint (`POST /mcp`):** Exposes `diet_read_skeleton` for on-demand AST skeletonization directly from MCP-compatible agents.
* **Exact Provider Usage & Cost Reconciliation:** Reconciles pre-flight token estimates with actual upstream `usage` and `cached_tokens` telemetry using model-aware input/cache pricing (`$0.00` for local Ollama / `localhost` endpoints).

### 5. Security & Monorepo Guardrails
* **Sensitive File Protection:** Blocks `.env`, `.pem`, `.key`, and private credential dotfiles from workspace indexing while allowlisting `.github` and `.gitignore`.
* **Monorepo Scaling Cap:** Caps workspace dependency scanning at 100 files to maintain low latency in large repositories.

---

## Quick Start

### 1. Install the Extension
Install the packaged VSIX in VS Code:
```bash
code --install-extension diet-toke-1.1.0.vsix
```
Then reload your VS Code window (`Cmd+Shift+P` / `Ctrl+Shift+P` → **`Developer: Reload Window`**).

### 2. Verify Status Bar & Agent Routing
* Confirm **`Diet Toke: -0% (0 saved)`** appears in the bottom-right VS Code status bar.
* Diet Toke automatically configures supported extensions (such as Cline) to route API traffic through `http://127.0.0.1:48192/proxy/<base64url-upstream>` and registers its local MCP server.

### 3. Monitor Live Savings
Click **`Diet Toke`** in the status bar to open **Live Token Analytics**, where you can inspect:
* Session & lifetime tokens saved and dollar cost savings
* Per-layer savings breakdown (AST Slicing, Tool Pruning, Log Distillation, History & Dedup)
* Billed vs. upstream cached token counts per request
* Controls to pause compression, clear the dedup cache, or reset counters

---

## Development & Release

```bash
# Type-check and compile
npx tsc --noEmit

# Package VSIX
npm run package

# Commit and tag release
git add -A && git commit -m "Release v1.1.0" && git tag -a v1.1.0 -m "Diet Toke v1.1.0"
```

---

## License

MIT