import { afterEach, describe, expect, it, vi } from 'vitest';

import { streamOllamaChat } from '../../src/adapter/OllamaConnector';
import { ollamaChatChunks, ollamaErrorChunk, toNdjson } from '../fixtures/modelResponses';

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
      'http://localhost:11434/api/chat',
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