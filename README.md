# Red Ledger

Local-first desktop chat for working with LLMs and your files.

No accounts, no cloud sync, no telemetry. Settings and chat data stay on your machine.

## What It Does

- Multi-provider chat with streaming: OpenAI, OpenRouter, Ollama, LM Studio, and any custom OpenAI-compatible server (llama.cpp, vLLM, Jan, a self-hosted gateway).
- Tool calling for local file ops + web/wiki/url tools (up to 75 tool calls per turn, with check-in nudges to the model at 25, 40, and 50).
- Workspace jail for file safety, with optional strict confirmation mode.
- Each chat remembers its workspace folder and switches back to it when reopened.
- Replies run in the background: a chat keeps replying (in its own folder) while you read or write in other chats, and several chats can reply at once. A reply survives View → Reload, and quitting mid-reply keeps what it wrote. A spinner in the chat list marks the chats that are working.
- Context profiles: sets of 3 context files (`system`, `user`, `org`) injected into every run. Each chat remembers its own profile, picked in the Context panel.
- MCP connections: add stdio or Streamable HTTP MCP servers in Settings; their tools join the built-in ones.
- Text file attachments of any kind: plain text, code, config, and markup (`.py`, `.yaml`, `.json`, `.xml`, `.css`, `Dockerfile`, ...) are detected by content, no renaming needed. PDF and Word (`.doc`, `.docx`) text extraction included.
- Spreadsheet attachments: Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`), OpenDocument (`.ods`), Apple Numbers and older formats are converted to CSV per sheet, with cell ranges, hyperlinks (as Markdown links), formulas and named ranges. `.csv` and `.tsv` attach as-is.
- Image file attachments from `.png`, `.jpeg/.jpg`, `.webp`, and `.gif` for vision capable models.
- Local SQLite conversation history with branching: Retry and Edit keep every version of a message, and a `‹ 1/2 ›` switcher moves between them in the same chat. Fork copies the branch on screen into a new chat.
- Storage panel (Settings → Storage): database size, chats sorted by size on disk, the largest images, and manual Remove / Compact / Clear caches. Nothing is deleted automatically.
- Favorite models: star models in Settings for one-click switching.
- Per-chat info popover (model, request settings, counts) from the chat header.
- Context meter under the message box: a small bar showing how much of the model's context window the chat's last reply used (hover for the numbers). See [Context Meter](#context-meter).
- Compact: the Compact button left of the context meter has the model summarize the chat so far. The chat continues from the summary; earlier messages stay on screen but are no longer sent.
- Auto-compact (Settings, Advanced; on by default): when a reply has used 80% of the model's context window, or leaves fewer than 32k tokens free (whichever comes first; on small windows at most a quarter is kept free), the chat is compacted right after it, with a notice saying so. That's 96k of a 128k window, 205k of 256k, 800k of 1M. It always happens before old tool results start being shortened (85%), so the summary sees the whole chat. It only runs for models whose window size is known, never after a reply you stopped or that failed, and it can be stopped like any reply.
- Undo file changes: every reply's workspace file changes can be undone from that reply's actions (Undo file changes), which puts each file back the way it was before the reply.
- API keys are saved encrypted with the OS keychain, or read from an environment variable when entered as `${env:NAME}`.

## Quick Start

### Prerequisites

- Node.js 22.12+ (24 recommended; Electron 44 bundles Node 24)
- npm
- Optional local runtimes:
  - Ollama (`http://localhost:11434`)
  - LM Studio (`http://localhost:1234`)

### Install + Run

```bash
git clone https://github.com/daniella256k/red-ledger.git
cd red-ledger
npm install
npm run dev
```

### Build

```bash
npm run build
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Electron + Vite dev mode |
| `npm run build` | Production build |
| `npm run check:build` | Checks the build in `out/`: every bundle parses, and background tasks run (CI runs it after every build) |
| `npm run preview` | Preview production build |
| `npm run typecheck` | TypeScript checks |
| `npm run lint` | ESLint |
| `npm run test` | Run tests once |
| `npm run test:watch` | Run tests in watch mode |

Unpackaged runs (`npm run dev`, `npm run preview`) use their own profile folder, `red-ledger-dev`, next to the installed app's, so development never opens your real chats. Pass `-- --user-data-dir=<folder>` to choose another.

## Provider Notes

- OpenAI and OpenRouter use OpenAI-style APIs.
- Ollama uses local Ollama endpoints.
- LM Studio uses its OpenAI-compatible endpoints (`/v1`), which support tools.
- Custom (OpenAI-compatible) takes any base URL up to the `/v1` path (default `http://localhost:8080/v1`, llama.cpp's server). The API key is optional and only sent when set.
- A reply cut off by the Max Tokens limit shows a warning instead of passing as a complete answer.
- Prompt caching: a reply that calls tools resends the whole chat with every request, and providers can serve the part they have seen from a cache (cheaper and faster). Through OpenRouter every chat request carries the chat's id as `session_id`, so it keeps reaching the same provider's cache, and Anthropic models are asked to cache (`cache_control`, kept 5 minutes). OpenAI gets the chat's id as `prompt_cache_key`. OpenAI, DeepSeek, Grok, Moonshot and Gemini 2.5+ cache on their own. Requests start with the same tools and history every time so the cached part keeps matching. When the provider reports it, the context meter's tooltip and the chat info popover show how much of the last reply's input came from the cache.

## Context Meter

After each reply, a small bar at the bottom right of the chat fills to show the tokens the reply's final request used (history, tool results and tool definitions, plus the generated text) against the model's context window. It turns red past 80%. Hover it for the numbers, e.g. `12.4k of 128k tokens used (10%)`; when the window is unknown the bar stays empty and the tooltip shows the count alone. It is saved with the chat, so it changes with the chat you select.

When a chat gets long, **Compact** (left of the meter) asks the model for a summary of everything so far: goals, decisions, findings with their sources, files changed, and where the work stands. The summary appears in the chat as a collapsible divider, and from then on each request sends the system prompt, the summary and the messages after it instead of the full history. Compacting again folds the earlier summary into the new one. Editing or retrying a message above the divider starts a branch without it, which sees the full history again.

- Token counts come from the provider: OpenAI-compatible servers report them via `stream_options.include_usage`, and Ollama via its eval counts. When a server reports nothing, the count is estimated from text length (shown with `~`).
- The context window comes from the provider when it publishes one: OpenRouter and vLLM model listings, the window LM Studio loaded the model with, or Ollama's loaded `num_ctx` (`/api/ps`). OpenAI's API doesn't publish it, so only the token count is shown there.

## Data + Storage

- Settings: `settings.json`
- API keys: `api-keys.json` next to `settings.json`, encrypted with the OS keychain (DPAPI on Windows), so `settings.json` holds them blank. Keys saved as plain text by earlier versions move there on first launch. A key entered as `${env:NAME}` (e.g. `${env:OPENAI_API_KEY}`) is kept as written and read from the environment instead. Without a keychain (some Linux setups, including Electron's `basic_text` fallback, which protects nothing) keys stay in `settings.json`, and Settings says so; keys saved under that fallback by an earlier version move there on first launch, and MCP sign-ins saved under it are kept and saved unencrypted from their next change. The keychain is tied to your OS account, so a copied profile or portable folder needs its keys entered again.
- File history: before a reply first changes a workspace file, its previous content is kept in `conversations.db` (gzipped, stored once per distinct content; files over 25 MB are not kept). Undo file changes on the reply restores those files and deletes files the reply created, after a confirmation that lists each file and warns about files changed since. History is deleted with its reply or chat. Nothing is written next to your files.
- Conversations/messages: `conversations.db` (SQLite, WAL). The database records its schema version (SQLite `user_version`); each upgrade step runs once, and a database from a newer Red Ledger is refused with a message rather than opened.
- Messages form a tree: each one records the message it follows, so a retry or edit adds a sibling instead of replacing anything. A chat shows one branch at a time and remembers which.
- Images are stored once each, as raw bytes keyed by their SHA-256, and shared by every message (and fork) that uses them. Text attachments stay inside their message.
- Deleting chats or images leaves free space inside the file; Settings → Storage → Compact database gives it back to the disk and clears the deleted data from the file for good.

### Upgrading from 1.7

The first launch of 1.8 converts the database in place, once (a few seconds for a large history): images move out of the message text into the image store, and every existing chat becomes a single branch. This is one-way: 1.7 can't read the converted database. If you might want to go back, copy `conversations.db` somewhere safe (with the app closed) before upgrading.

## Tool System

The LLM can invoke these tools during a conversation:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file from the workspace, a page at a time (any size; binary files are refused) |
| `write_file` | Write or overwrite a workspace file |
| `write_pdf` | Render markdown content and write a PDF file |
| `append_file` | Append content to a workspace file |
| `edit_file` | Exact-match find-and-replace inside a workspace file |
| `move_file` | Move or rename a file within the workspace (never overwrites) |
| `grep_files` | Search workspace file contents (literal or regex, respects `.gitignore`) |
| `list_files` | List the workspace directory tree (up to 1,000 entries, top levels first) |
| `web_search` | Search the web (Tavily or SerpAPI) |
| `org_search` | Search the web (Tavily or SerpAPI) using optional site specification (Org Site in settings) |
| `wiki_search` | Search Wikipedia for article summaries |
| `fetch_url` | Fetch and parse a full webpage by URL (includes extracted `links` for navigation) |

MCP servers configured under Settings → Connections add their tools as `<server>__<tool>` (servers whose names collide get `-2`, `-3`, ...). Click a connected server's tool count to switch individual tools on or off; switched-off tools are never sent to the model, and tools a server adds later start on. View JSON shows the whole server list in the usual `mcpServers` format, with env and header values masked until revealed, and can be edited and applied in place.

Server configs can use `${workspaceFolder}`, `${workspaceFolderBasename}`, `${userHome}`, `${env:NAME}` (or `${NAME}`), each with an optional `:-fallback`, in the command, args, env, working folder, URL, headers and OAuth fields. Local commands run in their configured working folder (default: your home folder); servers that use `${workspaceFolder}` restart when the open workspace changes.

Remote servers that require an account show a Sign in button: Red Ledger registers itself with the server's OAuth provider, opens the sign-in page in your browser and receives the result on a one-time `http://127.0.0.1:<port>/callback` page. Tokens are stored in `mcp-auth.json` next to `settings.json`, encrypted with the OS keystore when available, and refreshed automatically. Providers that require your own OAuth app take a client ID/secret, scope and fixed callback port under "Sign-in options". A server with its own `Authorization` header is never asked to sign in.

A reply's file changes can be undone from the reply (see File history under [Data + Storage](#data--storage)). Offline Mode (Settings) hides every tool that reaches the network: web/org/wiki search, `fetch_url`, and HTTP MCP connections.

Tools self-register via the tool registry. Strict mode shows a native confirmation dialog before each operation; with no app window to ask over, a question counts as denied, so nothing it guards happens unconfirmed. Tool errors are caught and returned in the result so the LLM can self-correct without crashing the stream. Pressing Stop ends the whole turn at once: no further tool calls or model requests run. A tool still working is told to stop (an open confirmation closes unanswered, and an MCP call is cancelled on its server) and its result is recorded as unknown; file changes it made can still be undone from the reply.

Heavy work runs in the background, not the main process: workspace searches (`grep_files`) in a worker thread, and pulling text out of PDFs, Word files and spreadsheets (for `read_file` and attachments) plus paging through text files too large to load whole in a separate utility process, so a parser that crashes on a bad file can't take the app with it. A big search or a slow PDF doesn't hold up other chats or the window. A task that runs too long (1 minute for a search, 3 for documents) is stopped; other tasks waiting behind it start again rather than failing with it.

Later turns send the model its earlier tool calls with their full results, in the standard tool-message format, so it can rely on what it already fetched or read. Only if a chat would overflow a model's known context window are the oldest results shortened (with a note to the model and a notice in the chat).

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
|   |   |-- ConversationService.ts   # SQLite chats, message tree, image store, full-text search
|   |   |-- DocumentTextService.ts   # PDF/Word/spreadsheet text extraction dispatch
|   |   |-- LlmService.ts            # Streaming, tool loop, context usage
|   |   |-- TurnService.ts           # Runs each chat turn (reply or compaction) and saves it as it streams
|   |   |-- McpService.ts            # MCP connections; registers <server>__<tool> tools
|   |   |-- PdfAttachmentService.ts
|   |   |-- PdfRenderService.ts      # Markdown -> PDF for write_pdf
|   |   |-- SearchService.ts         # Web/wiki search + fetch_url
|   |   |-- SettingsService.ts
|   |   |-- SpreadsheetAttachmentService.ts
|   |   |-- StorageService.ts        # Database/cache sizes, compact, clear caches
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

Place a `settings.json` file in the `resources/` directory next to the executable (for the single-file Windows portable `.exe`, create a `resources/` folder beside it). When detected, Red Ledger stores settings and the SQLite database there instead of in the OS user data path. Useful for USB deployments. Context profiles still live in the OS user data path.

## License

[MIT](LICENSE)
