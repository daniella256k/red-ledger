# Red Ledger

Local-first desktop chat for working with LLMs and your files.

No accounts, no cloud sync, no telemetry. Settings and chat data stay on your machine.

## What It Does

- Multi-provider chat with streaming: OpenAI, OpenRouter, Ollama, LM Studio, and any custom OpenAI-compatible server (llama.cpp, vLLM, Jan, a self-hosted gateway).
- Tool calling for local file ops + web/wiki/url tools (up to 75 tool calls per turn, with check-in nudges to the model at 25, 40, and 50).
- Workspace jail for file safety, with optional strict confirmation mode.
- Each chat remembers its workspace folder and switches back to it when reopened. A reply in progress keeps working in its own chat's folder even if you switch to another chat.
- Context profiles: sets of 3 context files (`system`, `user`, `org`) injected into every run. Each chat remembers its own profile, picked in the Context panel.
- MCP connections: add stdio or Streamable HTTP MCP servers in Settings; their tools join the built-in ones.
- Text file attachments of any kind: plain text, code, config, and markup (`.py`, `.yaml`, `.json`, `.xml`, `.css`, `Dockerfile`, ...) are detected by content, no renaming needed. PDF and Word (`.doc`, `.docx`) text extraction included.
- Spreadsheet attachments: Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`), OpenDocument (`.ods`), Apple Numbers and older formats are converted to CSV per sheet, with cell ranges, hyperlinks (as Markdown links), formulas and named ranges. `.csv` and `.tsv` attach as-is.
- Image file attachments from `.png`, `.jpeg/.jpg`, `.webp`, and `.gif` for vision capable models.
- Local SQLite conversation history with retry/copy message actions.
- Favorite models: star models in Settings for one-click switching.
- Per-chat info popover (model, request settings, counts) from the chat header.
- Context meter under the message box: how much of the model's context window the chat's last reply used. See [Context Meter](#context-meter).

## Quick Start

### Prerequisites

- Node.js 18+
- npm
- Optional local runtimes:
  - Ollama (`http://localhost:11434`)
  - LM Studio (`http://localhost:1234`)

### Install + Run

```bash
git clone https://github.com/domwxyz/red-ledger.git
cd red-ledger
npm install
npm run dev
```

### Build

```bash
npm run build
```

### Native Rebuild (if needed)

```bash
npm run rebuild
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Electron + Vite dev mode |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |
| `npm run rebuild` | Rebuild `better-sqlite3` for Electron |
| `npm run typecheck` | TypeScript checks |
| `npm run lint` | ESLint |
| `npm run test` | Run tests once |
| `npm run test:watch` | Run tests in watch mode |

## Provider Notes

- OpenAI and OpenRouter use OpenAI-style APIs.
- Ollama uses local Ollama endpoints.
- LM Studio supports both:
  - OpenAI-compatible endpoints
  - Native LM Studio endpoints

LM Studio compatibility mode is set in the app Settings panel.
- Custom (OpenAI-compatible) takes any base URL up to the `/v1` path (default `http://localhost:8080/v1`, llama.cpp's server). The API key is optional and only sent when set.
- A reply cut off by the Max Tokens limit shows a warning instead of passing as a complete answer.

## Context Meter

After each reply, the bottom right of the chat shows the tokens the reply's final request used (history, tool results and tool definitions, plus the generated text) against the model's context window, e.g. `12.4k / 128k tokens`. It turns red past 80%. Hover it for the breakdown. It is saved with the chat, so it changes with the chat you select.

- Token counts come from the provider: OpenAI-compatible servers report them via `stream_options.include_usage`, and Ollama via its eval counts. When a server reports nothing, the count is estimated from text length (shown with `~`).
- The context window comes from the provider when it publishes one: OpenRouter and vLLM model listings, the window LM Studio loaded the model with, or Ollama's loaded `num_ctx` (`/api/ps`). OpenAI's API doesn't publish it, so only the token count is shown there.

## Data + Storage

- Settings: `settings.json`
- Conversations/messages: `conversations.db` (SQLite, WAL)
- Message attachments are stored as structured data (`Attachment[]`) in the DB.
- Messages are listed in chronological order (`created_at ASC`).

## Tool System

The LLM can invoke these tools during a conversation:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file from the workspace |
| `write_file` | Write or overwrite a workspace file |
| `write_pdf` | Render markdown content and write a PDF file |
| `append_file` | Append content to a workspace file |
| `edit_file` | Exact-match find-and-replace inside a workspace file |
| `move_file` | Move or rename a file within the workspace (never overwrites) |
| `grep_files` | Search workspace file contents (literal or regex, respects `.gitignore`) |
| `list_files` | List the workspace directory tree |
| `web_search` | Search the web (Tavily or SerpAPI) |
| `org_search` | Search the web (Tavily or SerpAPI) using optional site specification (Org Site in settings) |
| `wiki_search` | Search Wikipedia for article summaries |
| `fetch_url` | Fetch and parse a full webpage by URL (includes extracted `links` for navigation) |

MCP servers configured under Settings → Connections add their tools as `<server>__<tool>` (servers whose names collide get `-2`, `-3`, ...). Click a connected server's tool count to switch individual tools on or off; switched-off tools are never sent to the model, and tools a server adds later start on. View JSON shows the whole server list in the usual `mcpServers` format, with env and header values masked until revealed, and can be edited and applied in place.

Server configs can use `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:NAME}` (or `${NAME}`), each with an optional `:-fallback`, in the command, args, env, working folder, URL, headers and OAuth fields. Local commands run in their configured working folder (default: your home folder); servers that use `${workspaceFolder}` restart when the open workspace changes.

Remote servers that require an account show a Sign in button: Red Ledger registers itself with the server's OAuth provider, opens the sign-in page in your browser and receives the result on a one-time `http://127.0.0.1:<port>/callback` page. Tokens are stored in `mcp-auth.json` next to `settings.json`, encrypted with the OS keystore when available, and refreshed automatically. Providers that require your own OAuth app take a client ID/secret, scope and fixed callback port under "Sign-in options". A server with its own `Authorization` header is never asked to sign in.

Overwrites and edits keep the previous version next to the file as `<name>.bak`. Offline Mode (Settings) hides every tool that reaches the network: web/org/wiki search, `fetch_url`, and HTTP MCP connections.

Tools self-register via the tool registry. Strict mode shows a native confirmation dialog before each operation. Tool errors are caught and returned in the result so the LLM can self-correct without crashing the stream. Pressing Stop ends the whole turn: no further tool calls or model requests run, even if it is pressed while a tool is working.

## Project Map

```text
red-ledger/
|-- electron/
|   |-- main.ts                      # App lifecycle + IPC wiring
|   |-- preload.ts                   # Exposes window.redLedger
|   |-- ipc/                         # Typed IPC contract (contract.ts) + thin handlers
|   |-- services/                    # Core domain services
|   |   |-- AttachmentService.ts     # Attachment parsing (text, images, documents)
|   |   |-- ChatTransferService.ts   # Chat import/export (Markdown, XML)
|   |   |-- ContextService.ts        # Context profiles + system prompt assembly
|   |   |-- ConversationService.ts   # SQLite chats/messages + full-text search
|   |   |-- DocumentTextService.ts   # PDF/Word/spreadsheet text extraction dispatch
|   |   |-- LlmService.ts            # Streaming, tool loop, context usage
|   |   |-- McpService.ts            # MCP connections; registers <server>__<tool> tools
|   |   |-- PdfAttachmentService.ts
|   |   |-- PdfRenderService.ts      # Markdown -> PDF for write_pdf
|   |   |-- SearchService.ts         # Web/wiki search + fetch_url
|   |   |-- SettingsService.ts
|   |   |-- SpreadsheetAttachmentService.ts
|   |   |-- WordAttachmentService.ts
|   |   |-- WorkspaceService.ts      # Jailed file operations
|   |   |-- pathJail.ts
|   |   `-- gitignore.ts
|   `-- lib/
|       |-- providers/               # openai/openrouter/ollama/lmstudio/custom
|       `-- tools/                   # tool registry, executor, arg validation
|-- src/
|   |-- components/
|   |   |-- Chat/
|   |   |-- Context/
|   |   |-- Editor/
|   |   |-- FileTree/
|   |   |-- Sidebar/
|   |   `-- ui/
|   |-- hooks/                       # useStreaming (stream lifecycle)
|   |-- lib/
|   |-- store/                       # Zustand stores
|   |-- styles/
|   `-- types/
|-- contexts/                        # bundled prompt seeds
|-- build/                           # app icons
|-- electron.vite.config.ts
`-- package.json
```

## Packaging

```bash
npm run dist:win
npm run dist:mac
npm run dist:linux
```

These run `electron-vite build` before `electron-builder`. Running `npx electron-builder` directly packages whatever is in `out/` as-is, which can produce an app with a blank window if `out/renderer` is stale or missing.

## Portable Mode

Place a `settings.json` file in the `resources/` directory next to the executable. When detected, Red Ledger stores settings and the SQLite database alongside the binary instead of in the OS user data path. Useful for USB deployments.

## License

[MIT](LICENSE)
