import { afterEach, describe, expect, it, vi } from 'vitest';

import { OllamaConnector, OllamaConnectorError, streamOllamaChat } from '../../src/adapter';
import { emptyOllamaTagsResponse, ollamaChatChunks, ollamaErrorChunk, ollamaTagsResponse, toNdjson } from '../fixtures/modelResponses';

describe('streamOllamaChat integration harness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('streams mocked Ollama NDJSON deltas and returns the accumulated response', async () => {
    const deltas: string[] = [];
    const fetchMock = vi.fn(async () => createNdjsonResponse(toNdjson(ollamaChatChunks)));
    vi.stubGlobal('fetch', fetchMock);

    const response = await streamOllamaChat({
      baseUrl: 'http://localhost:11434',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Say hello' }],
      onDelta: (delta) => deltas.push(delta)
    });

    expect(response).toBe('Hello, local model.');
    expect(deltas).toEqual(['Hello', ', local', ' model.']);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://localhost:11434/api/chat'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('surfaces mocked Ollama stream error payloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(toNdjson([ollamaErrorChunk]))));

    await expect(streamOllamaChat({
      baseUrl: 'http://localhost:11434',
      model: 'missing-model',
      messages: [{ role: 'user', content: 'Say hello' }],
      onDelta: () => undefined
    })).rejects.toThrow('Ollama error: model not found');
  });

  it('lists Ollama models with shared metadata fields', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

    const models = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels();

    expect(models).toEqual([
      expect.objectContaining({ id: 'llama3.2:latest', quantization: 'Q4_K_M', maxTokens: 4096 }),
      expect.objectContaining({ id: 'qwen2.5-coder:14b', quantization: 'Q5_K_M', maxTokens: 8192 })
    ]);
  });

  it('reports health from the Ollama tags endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

    const health = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).getHealth('request-1');

    expect(health).toMatchObject({
      requestId: 'request-1',
      status: 'ok',
      connectorId: 'ollama'
    });
  });

  it('discovers degraded capabilities when Ollama has no local models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(emptyOllamaTagsResponse)));

    const discovery = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).discoverCapabilities('request-2');

    expect(discovery).toMatchObject({
      health: { status: 'degraded' },
      capabilities: { healthCheck: true, modelListing: true, chatStreaming: false },
      models: [],
      failure: 'No local Ollama models are installed. Pull a model with `ollama pull <model>` and try again.'
    });
  });

  it('throws structured connector errors for malformed stream events', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse('{not-json}\n')));

    await expect(streamOllamaChat({
      baseUrl: 'http://localhost:11434',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Say hello' }],
      onDelta: () => undefined
    })).rejects.toMatchObject({
      name: 'OllamaConnectorError',
      code: 'malformed_event',
      retryable: true
    });
  });

  it('throws structured connector errors for non-OK HTTP responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));

    await expect(new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels()).rejects.toMatchObject({
      name: 'OllamaConnectorError',
      code: 'unsupported_feature',
      status: 404,
      retryable: false
    });
  });
});

function createNdjsonResponse(body: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    }
  });

  return new Response(stream, { status: 200 });
}