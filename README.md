# Red Ledger

Local-first desktop chat for working with LLMs and your files.

No accounts, no cloud sync, no telemetry. Settings and chat data stay on your machine.

## What It Does

- Multi-provider chat with streaming: OpenAI, OpenRouter, Ollama, and LM Studio.
- Tool calling for local file ops + web/wiki/url tools (up to 75 tool calls per turn, with check-in nudges to the model at 25, 40, and 50).
- Workspace jail for file safety, with optional strict confirmation mode.
- 3 persistent context files (`system`, `user`, `org`) injected into every run.
- Text file attachments of any kind: plain text, code, config, and markup (`.py`, `.yaml`, `.json`, `.xml`, `.css`, `Dockerfile`, ...) are detected by content, no renaming needed. PDF and Word (`.doc`, `.docx`) text extraction included.
- Spreadsheet attachments: Excel (`.xlsx`, `.xlsm`, `.xlsb`, `.xls`), OpenDocument (`.ods`), Apple Numbers and older formats are converted to CSV per sheet, with cell ranges, hyperlinks (as Markdown links), formulas and named ranges. `.csv` and `.tsv` attach as-is.
- Image file attachments from `.png`, `.jpeg/.jpg`, `.webp`, and `.gif` for vision capable models.
- Local SQLite conversation history with retry/copy message actions.
- Favorite models: star models in Settings for one-click switching.
- Per-chat info popover (model, request settings, counts) from the chat header.

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
| `list_files` | List the workspace directory tree |
| `web_search` | Search the web (Tavily or SerpAPI) |
| `org_search` | Search the web (Tavily or SerpAPI) using optional site specification (Org Site in settings) |
| `wiki_search` | Search Wikipedia for article summaries |
| `fetch_url` | Fetch and parse a full webpage by URL (includes extracted `links` for navigation) |

Tools self-register via the tool registry. Strict mode shows a native confirmation dialog before each operation. Tool errors are caught and returned in the result so the LLM can self-correct without crashing the stream.

## Project Map

```text
red-ledger/
|-- electron/
|   |-- main.ts                      # App lifecycle + IPC wiring
|   |-- preload.ts                   # Exposes window.redLedger
|   |-- ipc/                         # Typed IPC contract + handlers
|   |-- services/                    # Core domain services
|   |   |-- AttachmentService.ts
|   |   |-- ConversationService.ts
|   |   |-- ContextService.ts
|   |   |-- DocumentTextService.ts   # PDF/Word/spreadsheet text extraction dispatch
|   |   |-- LlmService.ts
|   |   |-- PdfAttachmentService.ts
|   |   |-- SearchService.ts
|   |   |-- SettingsService.ts
|   |   |-- SpreadsheetAttachmentService.ts
|   |   |-- WordAttachmentService.ts
|   |   `-- WorkspaceService.ts
|   `-- lib/
|       |-- providers/               # openai/openrouter/ollama/lmstudio
|       `-- tools/                   # tool registry, executor, arg validation
|-- src/
|   |-- components/
|   |   |-- Chat/
|   |   |-- Context/
|   |   |-- Editor/
|   |   `-- Sidebar/
|   |-- hooks/
|   |-- lib/
|   |-- store/
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
