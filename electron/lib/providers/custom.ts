import { LOCAL_SERVER_STREAM_TIMEOUT_MS, OpenAIProvider } from './openai'
import { registerProvider } from './registry'

/**
 * Custom provider — any server that speaks the OpenAI chat completions API
 * (llama.cpp, vLLM, Jan, a self-hosted gateway). The user supplies the base URL;
 * the API key is optional and only sent when set.
 */
registerProvider({
  name: 'custom',
  displayName: 'Custom (OpenAI-compatible)',
  defaultBaseUrl: 'http://localhost:8080/v1',
  factory: (settings) => new OpenAIProvider(settings.apiKey, settings.baseUrl, { streamTimeoutMs: LOCAL_SERVER_STREAM_TIMEOUT_MS })
})
