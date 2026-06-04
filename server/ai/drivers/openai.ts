/**
 * OpenAI driver — direct HTTP against the Responses API.
 *
 * Talks to `POST https://api.openai.com/v1/responses` with no SDK: the shared
 * `http/` layer owns SSE parsing, the multi-turn tool loop, tool execution, and
 * error classification; `responses-shared.ts` owns the OpenAI-Responses mapping
 * (request `input`, `AiMessage[] → input[]`, and the SSE→AiStreamEvent
 * translator), shared with the OpenRouter driver. This file owns only the
 * OpenAI-specific transport: endpoint, bearer auth, and the static model list.
 *
 * Tools are sent with their canonical TypeBox `inputSchema` as the JSON Schema
 * `parameters` directly — no Zod bridge. `strict` is omitted (our schemas use
 * optionals, which strict mode forbids).
 *
 * OpenAI does not report per-call USD cost, so `usage.costUsd` is left
 * undefined and the persister prices the turn from `pricing.ts`.
 */

import type {
  AiAuthMode,
  AiProviderId,
  AiStreamEvent,
} from '../runtime/types'
import type {
  AiProvider,
  AiProviderModel,
  AiResolvedCredential,
  AiStreamRequest,
} from './types'
import { runToolLoop } from './http/toolLoop'
import { createResponsesAdapter } from './responses-shared'

const SUPPORTED_AUTH_MODES: AiAuthMode[] = ['apiKey']

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/responses'

// Static model list — current as of May 2026. Same maintenance pattern as
// anthropic.ts (one update per provider release cycle; the alternative of
// hitting `client.models.list` on every model-picker open is too slow).
//
// Sources:
//   - https://developers.openai.com/api/docs/models/all
//   - https://developers.openai.com/api/docs/models/gpt-5.5
//   - https://developers.openai.com/api/docs/models/gpt-5.4
const MODELS: AiProviderModel[] = [
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    tier: 'smartest',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',
    tier: 'smart',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',
    tier: 'fast',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
  {
    id: 'gpt-5.4-nano',
    label: 'GPT-5.4 Nano',
    tier: 'cheap',
    capabilities: { toolCalling: true, visionInput: true, promptCache: false, streaming: true },
  },
]

const openaiAdapter = createResponsesAdapter({
  label: 'OpenAI',
  endpoint: OPENAI_ENDPOINT,
  buildHeaders(req) {
    return {
      Authorization: `Bearer ${req.credentials.apiKey!}`,
      'content-type': 'application/json',
    }
  },
})

export const openaiDriver: AiProvider = {
  id: 'openai' as AiProviderId,
  label: 'OpenAI',
  supportedAuthModes: SUPPORTED_AUTH_MODES,

  capabilities(modelId: string) {
    const model = MODELS.find((m) => m.id === modelId)
    return model?.capabilities ?? {
      toolCalling: true,
      visionInput: false,
      promptCache: false,
      streaming: true,
    }
  },

  async listModels(_creds: AiResolvedCredential) {
    return MODELS
  },

  async *stream(req: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    if (req.credentials.authMode !== 'apiKey' || !req.credentials.apiKey) {
      // Defensive: a non-apiKey credential reaching the driver implies a
      // mismatched DB row or a bypassed UI. Fail cleanly instead of POSTing
      // and getting a generic 401.
      yield {
        type: 'error',
        message:
          'OpenAI requires an API key. Add an API-key credential in /admin/ai/providers and pick it for the site default.',
      }
      return
    }
    yield* runToolLoop(openaiAdapter, req)
  },
}
