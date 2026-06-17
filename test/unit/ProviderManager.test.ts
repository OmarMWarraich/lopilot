import { afterEach, describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  configuration: {
    localBackend: 'ollama',
    ollamaBaseUrl: 'http://localhost:11434',
    defaultModel: ''
  } as Record<string, string>,
  explicitKeys: new Set<string>()
}));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => vscodeState.configuration[key],
      inspect: (key: string) => vscodeState.explicitKeys.has(key) ? { workspaceValue: vscodeState.configuration[key] } : undefined
    })
  }
}));

import { ProviderManager } from '../../src/provider/ProviderManager';
import { emptyOllamaTagsResponse, ollamaTagsResponse } from '../fixtures/modelResponses';

describe('ProviderManager readiness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vscodeState.configuration = {
      localBackend: 'ollama',
      ollamaBaseUrl: 'http://localhost:11434',
      defaultModel: ''
    };
    vscodeState.explicitKeys = new Set<string>();
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

  it('applies explicit local backend and default model preferences', async () => {
    vscodeState.configuration = {
      localBackend: 'ollama',
      ollamaBaseUrl: 'http://localhost:11555/',
      defaultModel: 'llama3.2:latest'
    };
    vscodeState.explicitKeys = new Set(['localBackend', 'ollamaBaseUrl', 'defaultModel']);
    const manager = createManager({ activeProviderId: null, discoveredLocal: [] });

    const endpoint = await manager.applyPreferences();
    const config = manager.getConfig();

    expect(endpoint).toMatchObject({
      id: 'ollama-configured-localhost-11555',
      type: 'ollama',
      baseUrl: 'http://localhost:11555'
    });
    expect(config.activeProviderId).toBe('ollama-configured-localhost-11555');
    expect(config.activeModelId).toBe('llama3.2:latest');
    expect(config.lifecycleState).toBe('local-configured');
  });
});

function createManager(overrides: Record<string, unknown> = {}): ProviderManager {
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
      remoteRequestsAllowed: false,
      ...overrides
    }),
    update: async () => undefined,
    keys: () => []
  });
}