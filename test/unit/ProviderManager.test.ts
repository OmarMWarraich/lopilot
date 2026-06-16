import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({}));

import { ProviderManager } from '../../src/provider/ProviderManager';
import { emptyOllamaTagsResponse, ollamaTagsResponse } from '../fixtures/modelResponses';

describe('ProviderManager readiness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports ready Ollama capability and model state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

    const readiness = await createManager().getActiveProviderReadiness();

    expect(readiness).toMatchObject({
      availability: 'ready',
      capabilities: { healthCheck: true, modelListing: true, chatStreaming: true },
      models: [expect.objectContaining({ id: 'llama3.2:latest' }), expect.objectContaining({ id: 'qwen2.5-coder:14b' })]
    });
  });

  it('reports no-models when Ollama is reachable but empty', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(emptyOllamaTagsResponse)));

    const readiness = await createManager().getActiveProviderReadiness();

    expect(readiness).toMatchObject({
      availability: 'no-models',
      capabilities: { healthCheck: true, modelListing: true, chatStreaming: false },
      models: []
    });
    expect(readiness.detail).toContain('ollama pull');
  });

  it('reports unavailable when the active local connector cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connection refused');
    }));

    const readiness = await createManager().getActiveProviderReadiness();

    expect(readiness).toMatchObject({
      availability: 'unavailable',
      capabilities: { healthCheck: false, modelListing: false, chatStreaming: false },
      models: []
    });
    expect(readiness.detail).toContain('connection refused');
  });
});

function createManager(): ProviderManager {
  return new ProviderManager({
    get: () => ({
      discoveredLocal: [{
        id: 'ollama-localhost-11434',
        name: 'Ollama on localhost',
        type: 'ollama',
        baseUrl: 'http://localhost:11434',
        isDiscovered: true,
        addedAt: '2026-06-17T00:00:00.000Z'
      }],
      configuredLocal: [],
      configuredRemote: [],
      activeProviderId: 'ollama-localhost-11434',
      activeModelId: null,
      remoteRequestsAllowed: false
    }),
    update: async () => undefined,
    keys: () => []
  });
}