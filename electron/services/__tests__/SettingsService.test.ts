/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest'
import { sanitizeSettings } from '../SettingsService'

describe('sanitizeSettings', () => {
  it('returns defaults for undefined input', () => {
    const result = sanitizeSettings(undefined)
    expect(result.activeProvider).toBe('openrouter')
    expect(result.reasoningEnabled).toBe(true)
    expect(result.temperatureEnabled).toBe(false)
    expect(result.temperature).toBe(1.0)
    expect(result.maxTokensEnabled).toBe(false)
    expect(result.maxTokens).toBe(8192)
    expect(result.maxToolCalls).toBe(25)
    expect(result.strictMode).toBe(false)
    expect(result.darkMode).toBe(false)
    expect(result.orgSite).toBe('')
    expect(result.searchToolsEnabled).toBe(true)
    expect(result.defaultModel).toBe('moonshotai/kimi-k2.5')
    expect(result.providers.openrouter.selectedModel).toBe('moonshotai/kimi-k2.5')
    expect(result.providerSectionExpanded).toBe(true)
    expect(result.searchSectionExpanded).toBe(true)
    expect(result.advancedSectionExpanded).toBe(false)
  })

  it('returns defaults for empty object', () => {
    const result = sanitizeSettings({})
    expect(result.activeProvider).toBe('openrouter')
    expect(result.reasoningEnabled).toBe(true)
    expect(result.temperatureEnabled).toBe(false)
    expect(result.maxTokensEnabled).toBe(false)
    expect(result.maxToolCalls).toBe(25)
    expect(result.providers.openai.baseUrl).toBe('https://api.openai.com/v1')
    expect(result.providers.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1')
    expect(result.providers.ollama.baseUrl).toBe('http://localhost:11434')
    expect(result.providers.lmstudio.baseUrl).toBe('http://localhost:1234')
    expect(result.providers.lmstudio.compatibility).toBe('openai')
    expect(result.providers.openrouter.selectedModel).toBe('moonshotai/kimi-k2.5')
    expect(result.searchToolsEnabled).toBe(true)
    expect(result.providerSectionExpanded).toBe(true)
    expect(result.searchSectionExpanded).toBe(true)
    expect(result.advancedSectionExpanded).toBe(false)
  })

  it('preserves valid temperatureEnabled value', () => {
    expect(sanitizeSettings({ temperatureEnabled: true } as any).temperatureEnabled).toBe(true)
    expect(sanitizeSettings({ temperatureEnabled: false } as any).temperatureEnabled).toBe(false)
  })

  it('preserves valid reasoningEnabled value', () => {
    expect(sanitizeSettings({ reasoningEnabled: true } as any).reasoningEnabled).toBe(true)
    expect(sanitizeSettings({ reasoningEnabled: false } as any).reasoningEnabled).toBe(false)
  })

  it('defaults reasoningEnabled for invalid input', () => {
    expect(sanitizeSettings({ reasoningEnabled: 'yes' as any } as any).reasoningEnabled).toBe(true)
  })

  it('defaults temperatureEnabled for invalid input', () => {
    expect(sanitizeSettings({ temperatureEnabled: 'yes' as any } as any).temperatureEnabled).toBe(false)
  })

  it('preserves valid maxTokensEnabled value', () => {
    expect(sanitizeSettings({ maxTokensEnabled: true } as any).maxTokensEnabled).toBe(true)
    expect(sanitizeSettings({ maxTokensEnabled: false } as any).maxTokensEnabled).toBe(false)
  })

  it('defaults maxTokensEnabled for invalid input', () => {
    expect(sanitizeSettings({ maxTokensEnabled: 'yes' as any } as any).maxTokensEnabled).toBe(false)
  })

  it('preserves valid maxToolCalls value', () => {
    expect(sanitizeSettings({ maxToolCalls: 20 } as any).maxToolCalls).toBe(20)
    expect(sanitizeSettings({ maxToolCalls: 25 } as any).maxToolCalls).toBe(25)
  })

  it('defaults maxToolCalls for invalid input', () => {
    expect(sanitizeSettings({ maxToolCalls: 'yes' as any } as any).maxToolCalls).toBe(25)
  })

  it('preserves valid darkMode value', () => {
    expect(sanitizeSettings({ darkMode: true } as any).darkMode).toBe(true)
    expect(sanitizeSettings({ darkMode: false } as any).darkMode).toBe(false)
  })

  it('defaults darkMode for invalid input', () => {
    expect(sanitizeSettings({ darkMode: 'yes' as any } as any).darkMode).toBe(false)
  })

  it('clamps temperature to 0–2 range', () => {
    expect(sanitizeSettings({ temperature: -1 } as any).temperature).toBe(0)
    expect(sanitizeSettings({ temperature: 5 } as any).temperature).toBe(2)
    expect(sanitizeSettings({ temperature: 1.5 } as any).temperature).toBe(1.5)
  })

  it('rounds temperature to one decimal', () => {
    expect(sanitizeSettings({ temperature: 0.77 } as any).temperature).toBe(0.8)
    expect(sanitizeSettings({ temperature: 0.14 } as any).temperature).toBe(0.1)
  })

  it('clamps maxTokens to 1–128000', () => {
    expect(sanitizeSettings({ maxTokens: 0 } as any).maxTokens).toBe(1)
    expect(sanitizeSettings({ maxTokens: 200000 } as any).maxTokens).toBe(128000)
    expect(sanitizeSettings({ maxTokens: 1000 } as any).maxTokens).toBe(1000)
  })

  it('floors maxTokens to integer', () => {
    expect(sanitizeSettings({ maxTokens: 1000.7 } as any).maxTokens).toBe(1000)
  })

  it('clamps maxToolCalls to 1â€“25', () => {
    expect(sanitizeSettings({ maxToolCalls: 0 } as any).maxToolCalls).toBe(1)
    expect(sanitizeSettings({ maxToolCalls: 500 } as any).maxToolCalls).toBe(25)
    expect(sanitizeSettings({ maxToolCalls: 25 } as any).maxToolCalls).toBe(25)
  })

  it('floors maxToolCalls to integer', () => {
    expect(sanitizeSettings({ maxToolCalls: 25.9 } as any).maxToolCalls).toBe(25)
  })

  it('rejects NaN temperature', () => {
    expect(sanitizeSettings({ temperature: NaN } as any).temperature).toBe(1.0)
  })

  it('rejects NaN maxTokens', () => {
    expect(sanitizeSettings({ maxTokens: NaN } as any).maxTokens).toBe(8192)
  })

  it('rejects invalid activeProvider', () => {
    expect(sanitizeSettings({ activeProvider: 'invalid' } as any).activeProvider).toBe('openrouter')
  })

  it('preserves valid provider settings', () => {
    const result = sanitizeSettings({
      providers: {
        openai: { apiKey: 'sk-test', baseUrl: 'https://custom.api.com', models: ['gpt-4'] },
        openrouter: { apiKey: '', baseUrl: '', models: [] },
        ollama: { apiKey: '', baseUrl: '', models: [] }
      }
    } as any)
    expect(result.providers.openai.apiKey).toBe('sk-test')
    expect(result.providers.openai.baseUrl).toBe('https://custom.api.com')
    expect(result.providers.openai.models).toEqual(['gpt-4'])
  })

  it('falls back to default baseUrl for empty string', () => {
    const result = sanitizeSettings({
      providers: {
        openai: { apiKey: '', baseUrl: '', models: [] },
        openrouter: { apiKey: '', baseUrl: '  ', models: [] },
        ollama: { apiKey: '', baseUrl: '', models: [] }
      }
    } as any)
    expect(result.providers.openai.baseUrl).toBe('https://api.openai.com/v1')
    expect(result.providers.openrouter.baseUrl).toBe('https://openrouter.ai/api/v1')
  })

  it('filters non-string model entries', () => {
    const result = sanitizeSettings({
      providers: {
        openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4', 42, null, 'gpt-3.5'] },
        openrouter: { apiKey: '', baseUrl: '', models: [] },
        ollama: { apiKey: '', baseUrl: '', models: [] },
        lmstudio: { apiKey: '', baseUrl: '', models: [] }
      }
    } as any)
    expect(result.providers.openai.models).toEqual(['gpt-4', 'gpt-3.5'])
  })

  it('sanitizes lmstudio compatibility', () => {
    const valid = sanitizeSettings({
      providers: {
        lmstudio: { apiKey: '', baseUrl: 'http://localhost:1234', models: [], compatibility: 'lmstudio' }
      }
    } as any)
    expect(valid.providers.lmstudio.compatibility).toBe('lmstudio')

    const invalid = sanitizeSettings({
      providers: {
        lmstudio: { apiKey: '', baseUrl: 'http://localhost:1234', models: [], compatibility: 'invalid' }
      }
    } as any)
    expect(invalid.providers.lmstudio.compatibility).toBe('openai')
  })

  it('migrates legacy defaultModel into active provider selectedModel', () => {
    const result = sanitizeSettings({
      activeProvider: 'openai',
      defaultModel: 'gpt-4o-mini'
    } as any)

    expect(result.providers.openai.selectedModel).toBe('gpt-4o-mini')
  })

  it('preserves intentionally blank selectedModel values', () => {
    const result = sanitizeSettings({
      providers: {
        openai: { apiKey: '', baseUrl: 'https://api.openai.com/v1', models: [], selectedModel: '' },
        openrouter: { apiKey: '', baseUrl: 'https://openrouter.ai/api/v1', models: [], selectedModel: '' }
      }
    } as any)

    expect(result.providers.openai.selectedModel).toBe('')
    expect(result.providers.openrouter.selectedModel).toBe('')
  })

  it('preserves lastWorkspacePath when string', () => {
    const result = sanitizeSettings({ lastWorkspacePath: '/home/user/project' } as any)
    expect(result.lastWorkspacePath).toBe('/home/user/project')
  })

  it('nulls lastWorkspacePath for non-string', () => {
    expect(sanitizeSettings({ lastWorkspacePath: 42 } as any).lastWorkspacePath).toBeNull()
    expect(sanitizeSettings({ lastWorkspacePath: undefined } as any).lastWorkspacePath).toBeNull()
  })

  it('preserves orgSite when string', () => {
    const result = sanitizeSettings({ orgSite: 'news.example.com' } as any)
    expect(result.orgSite).toBe('news.example.com')
  })

  it('defaults orgSite for non-string input', () => {
    expect(sanitizeSettings({ orgSite: 42 as any } as any).orgSite).toBe('')
  })

  it('preserves searchToolsEnabled when boolean', () => {
    expect(sanitizeSettings({ searchToolsEnabled: true } as any).searchToolsEnabled).toBe(true)
    expect(sanitizeSettings({ searchToolsEnabled: false } as any).searchToolsEnabled).toBe(false)
  })

  it('defaults searchToolsEnabled for invalid input', () => {
    expect(sanitizeSettings({ searchToolsEnabled: 'yes' as any } as any).searchToolsEnabled).toBe(true)
  })

  it('preserves section visibility preferences when boolean', () => {
    const result = sanitizeSettings({
      providerSectionExpanded: false,
      searchSectionExpanded: false,
      advancedSectionExpanded: true
    } as any)

    expect(result.providerSectionExpanded).toBe(false)
    expect(result.searchSectionExpanded).toBe(false)
    expect(result.advancedSectionExpanded).toBe(true)
  })

  it('defaults section visibility preferences for invalid input', () => {
    const result = sanitizeSettings({
      providerSectionExpanded: 'yes',
      searchSectionExpanded: 1,
      advancedSectionExpanded: null
    } as any)

    expect(result.providerSectionExpanded).toBe(true)
    expect(result.searchSectionExpanded).toBe(true)
    expect(result.advancedSectionExpanded).toBe(false)
  })
})
