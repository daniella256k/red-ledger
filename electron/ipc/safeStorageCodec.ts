import { safeStorage } from 'electron'
import { PLAIN_TEXT_CODEC } from '../services/mcpOAuth'

/**
 * Encrypts with the OS keychain (DPAPI on Windows) when it is available; used
 * for API keys and MCP sign-in tokens. Without a keychain, text stays plain.
 */
export function safeStorageCodec(): { encrypted: boolean; encode(text: string): string; decode(data: string): string } {
  if (!safeStorage.isEncryptionAvailable()) return PLAIN_TEXT_CODEC
  return {
    encrypted: true,
    encode: (text) => safeStorage.encryptString(text).toString('base64'),
    decode: (data) => safeStorage.decryptString(Buffer.from(data, 'base64'))
  }
}
