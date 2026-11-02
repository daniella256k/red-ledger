import { dirname, join } from 'path'
import { handleIpc } from './typedIpc'
import { assertObject } from './validate'
import { SettingsService } from '../services/SettingsService'
import { safeStorageCodec } from './safeStorageCodec'
import type { Settings } from '../../src/types'

/**
 * Thin IPC adapter for settings.
 * All business logic lives in SettingsService.
 *
 * Side effects (like setting workspace path) are wired by the caller
 * via the onSettingsChanged callback.
 */

let service: SettingsService

/** Settings for main-process use, with `${env:NAME}` API keys read from the environment. */
export function getCurrentSettings(): Settings {
  if (!service) {
    throw new Error('SettingsService not initialized')
  }
  return service.getResolved()
}

export function registerSettingsHandlers(
  settingsPath: string,
  onSettingsChanged: (settings: Settings) => void
): void {
  // API keys are encrypted into a file beside settings.json (so portable mode keeps them together).
  service = new SettingsService(settingsPath, {
    secretsPath: join(dirname(settingsPath), 'api-keys.json'),
    getCodec: safeStorageCodec
  })

  // Apply side effects for initial settings
  onSettingsChanged(service.getCurrent())

  handleIpc('settings:load', () => {
    const settings = service.load()
    onSettingsChanged(settings)
    return settings
  })

  handleIpc('settings:keyStorage', () => (service.keysEncrypted() ? 'encrypted' : 'plain'))

  handleIpc('settings:save', (_e, settings) => {
    assertObject(settings, 'settings')
    const sanitized = service.save(settings)
    onSettingsChanged(sanitized)
  })
}
