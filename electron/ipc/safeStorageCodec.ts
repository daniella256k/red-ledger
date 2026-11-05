import { safeStorage } from 'electron'
import { PLAIN_TEXT_CODEC } from '../services/mcpOAuth'

/** Reads text safeStorage encrypted, as base64. */
function decryptBase64(data: string): string {
  return safeStorage.decryptString(Buffer.from(data, 'base64'))
}

/**
 * Encrypts with the OS keychain (DPAPI on Windows) when it is available; used
 * for API keys and MCP sign-in tokens. Without a keychain, text stays plain.
 *
 * On Linux without a secret store, Electron falls back to its `basic_text`
 * backend, which "encrypts" with a key built into every copy of Chromium: no
 * protection at all. That counts as plain text here, so the app never calls
 * it encrypted. Files an earlier version wrote that way can still be read
 * (`decodeEncrypted`), and are saved plain from then on.
 */
export function safeStorageCodec(): {
  encrypted: boolean
  encode(text: string): string
  decode(data: string): string
  decodeEncrypted?(data: string): string
} {
  if (!safeStorage.isEncryptionAvailable()) return PLAIN_TEXT_CODEC
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
    return { ...PLAIN_TEXT_CODEC, decodeEncrypted: decryptBase64 }
  }
  return {
    encrypted: true,
    encode: (text) => safeStorage.encryptString(text).toString('base64'),
    decode: decryptBase64
  }
}
