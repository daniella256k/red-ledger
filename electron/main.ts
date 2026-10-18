import { app, BrowserWindow, dialog, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { readFileSync } from 'fs'
import {
  COMMON_TEXT_EXTENSIONS,
  IMAGE_MIME_BY_EXTENSION,
  parseAttachmentPaths
} from './services/AttachmentService'
import { APP_NAME } from '../src/lib/appInfo'
import { resolveSettingsPath, resolveDbPath } from './services/SettingsService'
import { registerDbHandlers, getConversationService } from './ipc/db'
import { registerContextHandlers, getContextService } from './ipc/context'
import { registerSettingsHandlers, getCurrentSettings } from './ipc/settings'
import { registerFsHandlers, getWorkspaceService } from './ipc/fs'
import { registerLlmHandlers } from './ipc/llm'
import { registerSearchHandlers } from './ipc/search'
import { registerMcpHandlers, getMcpService } from './ipc/mcp'
import { registerTransferHandlers } from './ipc/transfer'
import { handleIpc } from './ipc/typedIpc'
import { assertObject } from './ipc/validate'

type RendererMenuAction = 'exportChat' | 'importChat'

function sendMenuAction(action: RendererMenuAction): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('menu:action', action)
}

let mainWindow: BrowserWindow | null = null
let ipcHandlersRegistered = false

const APP_WINDOW_TITLE = `${APP_NAME} ${app.getVersion()}`
const ABOUT_AUTHOR = 'D. Cusanelli'
const ABOUT_DESCRIPTION = 'Context Aware Command Center'

async function showHelpPopup(
  title: string,
  message: string,
  detail: string
): Promise<void> {
  if (!mainWindow) return

  await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['Close'],
    defaultId: 0,
    noLink: true,
    title,
    message,
    detail
  })
}

function setApplicationMenu(): void {
  const aboutDetail = [
    `Name: ${APP_NAME}`,
    `Version: ${app.getVersion()}`,
    `Author: ${ABOUT_AUTHOR}`,
    `Description: ${ABOUT_DESCRIPTION}`
  ].join('\n')

  const gettingStartedDetail = [
    '1. Choose your LLM provider in Settings.',
    '2. Enter your API key if available. (OpenRouter recommended)',
    '3. Enter your Search API key if using web search. (Tavily recommended)',
    '4. Open Workspace and choose your active folder.',
    '5. Set the System Prompt in the Context section.'
  ].join('\n')

  const isMac = process.platform === 'darwin'
  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'Export Chat…',
        accelerator: isMac ? 'Cmd+E' : 'Ctrl+E',
        click: () => sendMenuAction('exportChat')
      },
      {
        label: 'Import Chat…',
        accelerator: isMac ? 'Cmd+I' : 'Ctrl+I',
        click: () => sendMenuAction('importChat')
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' }
    ]
  }

  const menuTemplate: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [{ role: 'appMenu' as const }]
      : []),
    fileMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About',
          click: () => {
            void showHelpPopup(
              `About ${APP_NAME}`,
              APP_NAME,
              aboutDetail
            )
          }
        },
        {
          label: 'Getting Started',
          click: () => {
            void showHelpPopup(
              'Getting Started',
              `How to use ${APP_NAME}`,
              gettingStartedDetail
            )
          }
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))
}

const EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

function openExternalUrl(url: string): void {
  try {
    if (!EXTERNAL_URL_PROTOCOLS.has(new URL(url).protocol)) return
  } catch {
    return
  }
  void shell.openExternal(url)
}

function isSameAppUrl(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl)
    const target = new URL(targetUrl)
    if (current.protocol === 'file:') return target.protocol === 'file:' && current.pathname === target.pathname
    return current.origin === target.origin
  } catch {
    return false
  }
}

// ─── Single Instance Lock ────────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  }
})

// ─── Window Creation ─────────────────────────────────────────────────────────

function createWindow(): void {
  const prefersDarkMode = (() => {
    try {
      return getCurrentSettings().darkMode
    } catch {
      return false
    }
  })()

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: APP_WINDOW_TITLE,
    backgroundColor: prefersDarkMode ? '#1F1A19' : '#FDFCF8',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
      // Keep renderer timers and IPC handling active while minimized/backgrounded
      // so long-running streams/tool calls can complete.
      backgroundThrottling: false
    }
  })

  // Keep native window title controlled by main process.
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault()
    mainWindow?.setTitle(APP_WINDOW_TITLE)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.setTitle(APP_WINDOW_TITLE)
  })

  // ─── External links open in the default browser, never in-app ────────────
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL() ?? ''
    if (isSameAppUrl(currentUrl, url)) return
    event.preventDefault()
    openExternalUrl(url)
  })

  // Load the app
  if (process.env.NODE_ENV === 'development' || process.env.ELECTRON_RENDERER_URL) {
    const url = process.env.ELECTRON_RENDERER_URL || 'http://localhost:5173'
    mainWindow.loadURL(url)
    mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // ─── Right-click context menu (spell suggestions + edit actions) ─────────
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const {
      editFlags,
      isEditable,
      selectionText,
      misspelledWord,
      dictionarySuggestions = []
    } = params
    const hasSelection = selectionText.trim().length > 0
    const hasMisspelling = isEditable && misspelledWord.trim().length > 0

    const menuTemplate: MenuItemConstructorOptions[] = []

    if (hasMisspelling) {
      if (dictionarySuggestions.length > 0) {
        menuTemplate.push(...dictionarySuggestions.map((suggestion) => ({
          label: suggestion,
          click: () => {
            mainWindow?.webContents.replaceMisspelling(suggestion)
          }
        })))
      } else {
        menuTemplate.push({
          label: 'No Spelling Suggestions',
          enabled: false
        })
      }

      menuTemplate.push({
        label: `Add "${misspelledWord}" to Dictionary`,
        click: () => {
          mainWindow?.webContents.session.addWordToSpellCheckerDictionary(misspelledWord)
        }
      })
      menuTemplate.push({ type: 'separator' })
    }

    menuTemplate.push(
      {
        label: 'Cut',
        role: 'cut',
        enabled: isEditable && hasSelection && editFlags.canCut,
        visible: isEditable
      },
      {
        label: 'Copy',
        role: 'copy',
        enabled: hasSelection && editFlags.canCopy,
        visible: hasSelection || isEditable
      },
      {
        label: 'Paste',
        role: 'paste',
        enabled: isEditable && editFlags.canPaste,
        visible: isEditable
      },
      { type: 'separator', visible: isEditable },
      {
        label: 'Select All',
        role: 'selectAll',
        enabled: editFlags.canSelectAll,
        visible: isEditable
      }
    )

    const menu = Menu.buildFromTemplate(menuTemplate)

    // Only show the menu if there's something useful to show
    if (hasSelection || isEditable || hasMisspelling) {
      menu.popup()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ─── Path Resolution ────────────────────────────────────────────────────────

function getContextDir(): string {
  return join(app.getPath('userData'), 'contexts')
}

function getBundledContextDir(): string {
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    return join(app.getAppPath(), 'contexts')
  }
  return join(process.resourcesPath, 'contexts')
}

// ─── IPC Handler Registration ────────────────────────────────────────────────

function registerIpcHandlers(): void {
  if (ipcHandlersRegistered) return
  ipcHandlersRegistered = true

  // Resolve paths
  const settingsPath = resolveSettingsPath(process.resourcesPath, app.getPath('userData'))
  const dbPath = resolveDbPath(process.resourcesPath, app.getPath('userData'))

  // 1. Database (no dependencies)
  registerDbHandlers(dbPath)

  // 2. Settings (wires workspace path side effect)
  registerSettingsHandlers(settingsPath, (settings) => {
    // When settings change, sync workspace path to the workspace service.
    // This replaces the old hidden coupling between settings.ts and fs.ts.
    // Guard: WorkspaceService may not exist yet during initial settings load
    // (registerFsHandlers runs after this). The initial sync is handled
    // explicitly below.
    try {
      getWorkspaceService().setWorkspacePath(settings.lastWorkspacePath ?? null)
    } catch {
      // WorkspaceService not initialized yet — initial sync handled below
    }
    // Same for MCP connections: unchanged servers are left alone.
    try {
      getMcpService().applyServers(settings.mcpServers)
    } catch {
      // McpService not initialized yet — initial connect handled below
    }
  })

  // 3. File system (needs settings for strict mode checks)
  registerFsHandlers(getCurrentSettings)
  // Sync persisted workspace path now that WorkspaceService exists.
  getWorkspaceService().setWorkspacePath(getCurrentSettings().lastWorkspacePath ?? null)

  // 4. Context files
  registerContextHandlers(getContextDir(), getBundledContextDir())

  // 5. Search (needs settings for API keys)
  registerSearchHandlers(getCurrentSettings)

  // 6. MCP connections (registers each server's tools in the tool registry)
  registerMcpHandlers(getCurrentSettings)
  getMcpService().applyServers(getCurrentSettings().mcpServers)

  // 7. LLM streaming (needs settings + context for system prompt)
  registerLlmHandlers({
    getSettings: getCurrentSettings,
    getSystemPrompt: () => getContextService().assembleSystemPrompt()
  })

  // 8. Chat import/export
  registerTransferHandlers(getConversationService())

  // 9. Dialog handlers (remain inline — they're simple and window-dependent)
  handleIpc('dialog:confirm', async (_event, options) => {
    assertObject(options, 'options')
    if (!mainWindow) return false
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Cancel', 'OK'],
      defaultId: 0,
      title: options.title,
      message: options.message,
      detail: options.detail
    })
    return result.response === 1
  })

  handleIpc('dialog:openTextFile', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Load Context from File',
      filters: [
        { name: 'Text Files', extensions: ['md', 'txt', 'markdown'] },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) return null

    try {
      return readFileSync(result.filePaths[0], 'utf-8')
    } catch {
      return null
    }
  })

  handleIpc('dialog:openAttachmentFiles', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach Files',
      filters: [
        {
          name: 'Text, Code, PDF, Images',
          extensions: [
            ...COMMON_TEXT_EXTENSIONS,
            'pdf',
            ...Object.keys(IMAGE_MIME_BY_EXTENSION).map((extension) => extension.slice(1))
          ]
        },
        { name: 'All Files', extensions: ['*'] }
      ],
      properties: ['openFile', 'multiSelections']
    })

    if (result.canceled || result.filePaths.length === 0) return []

    const { attachments, failed } = await parseAttachmentPaths(result.filePaths)

    if (failed.length > 0) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['OK'],
        defaultId: 0,
        title: 'Attachment Parsing Failed',
        message: 'Some files could not be attached.',
        detail: failed.join('\n')
      })
    }

    return attachments
  })

  handleIpc('attachment:parseFiles', async (_event, filePaths) => {
    if (!Array.isArray(filePaths)) {
      return { attachments: [], failed: [] }
    }
    const validFilePaths = filePaths.filter((value): value is string => typeof value === 'string' && value.length > 0)
    if (validFilePaths.length === 0) {
      return { attachments: [], failed: [] }
    }
    return parseAttachmentPaths(validFilePaths)
  })
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerIpcHandlers()

  createWindow()
  setApplicationMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

let mcpShutdownStarted = false

app.on('before-quit', (event) => {
  // Close MCP connections (and their child processes) first, then quit for real.
  if (!mcpShutdownStarted) {
    mcpShutdownStarted = true
    let mcpService: ReturnType<typeof getMcpService> | null = null
    try {
      mcpService = getMcpService()
    } catch {
      // Never initialized
    }
    if (mcpService) {
      event.preventDefault()
      void mcpService.closeAll().finally(() => app.quit())
      return
    }
  }

  try {
    getConversationService()?.close()
  } catch {
    // Database may already be closed
  }
})
