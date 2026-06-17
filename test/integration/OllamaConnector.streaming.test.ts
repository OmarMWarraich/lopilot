import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OllamaConnector,
  OllamaConnectorError,
  streamOllamaChat,
  fetchOllamaModels,
  getOllamaHealth,
  discoverOllamaCapabilities
} from '../../src/adapter';
import { emptyOllamaTagsResponse, ollamaChatChunks, ollamaErrorChunk, ollamaTagsResponse, toNdjson } from '../fixtures/modelResponses';

describe('Ollama adapter streaming and event handling integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('stream event processing', () => {
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

    it('processes multiple deltas across multiple chunks correctly', async () => {
      const deltas: string[] = [];
      const chunks = [
        { message: { role: 'assistant', content: 'function ' }, done: false },
        { message: { role: 'assistant', content: 'fibonacci' }, done: false },
        { message: { role: 'assistant', content: '() {' }, done: false },
        { message: { role: 'assistant', content: '\n  // recursive' }, done: false },
        { message: { role: 'assistant', content: ' implementation\n}' }, done: true }
      ];
      
      vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(toNdjson(chunks))));

      const response = await streamOllamaChat({
        baseUrl: 'http://localhost:11434',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Write a fibonacci function' }],
        onDelta: (delta) => deltas.push(delta)
      });

      expect(deltas.length).toBe(5);
      expect(response).toBe('function fibonacci() {\n  // recursive implementation\n}');
    });

    it('surfaces mocked Ollama stream error payloads with proper error classification', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(toNdjson([ollamaErrorChunk]))));

      await expect(streamOllamaChat({
        baseUrl: 'http://localhost:11434',
        model: 'missing-model',
        messages: [{ role: 'user', content: 'Say hello' }],
        onDelta: () => undefined
      })).rejects.toMatchObject({
        name: 'OllamaConnectorError',
        message: 'Ollama error: model not found',
        code: 'unsupported_feature',
        retryable: false
      });
    });

    it('handles token usage tracking across stream chunks', async () => {
      const chunks = [
        { message: { role: 'assistant', content: 'Hello' }, prompt_eval_count: 12, eval_count: 1, done: false },
        { message: { role: 'assistant', content: ' world' }, prompt_eval_count: 12, eval_count: 2, done: true, done_reason: 'stop' }
      ];
      
      vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(toNdjson(chunks))));

      const connector = new OllamaConnector({ baseUrl: 'http://localhost:11434' });
      const result = await connector.streamChat({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Say hello' }],
        onDelta: () => undefined
      });

      expect(result.usage.promptTokens).toBe(12);
      expect(result.usage.completionTokens).toBe(2);
      expect(result.usage.totalTokens).toBe(14);
      expect(result.doneReason).toBe('stop');
    });

    it('accumulates empty message chunks without adding to delta', async () => {
      const deltas: string[] = [];
      const chunks = [
        { message: { role: 'assistant', content: 'Hello' }, done: false },
        { message: { role: 'assistant', content: '' }, done: false },
        { message: { role: 'assistant', content: ' world' }, done: true }
      ];
      
      vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(toNdjson(chunks))));

      const response = await streamOllamaChat({
        baseUrl: 'http://localhost:11434',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Say hello' }],
        onDelta: (delta) => deltas.push(delta)
      });

      // Empty deltas should be skipped
      expect(deltas).toEqual(['Hello', ' world']);
      expect(response).toBe('Hello world');
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

    it('handles chunks with partial content gracefully', async () => {
      const deltas: string[] = [];
      const chunks = [
        { done: false },
        { message: { role: 'assistant', content: 'partial' }, done: false },
        { done: true }
      ];
      
      vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(toNdjson(chunks))));

      const response = await streamOllamaChat({
        baseUrl: 'http://localhost:11434',
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Test' }],
        onDelta: (delta) => deltas.push(delta)
      });

      expect(response).toBe('partial');
      expect(deltas).toEqual(['partial']);
    });
  });

  describe('adapter HTTP error handling', () => {
    it('throws structured connector errors for non-OK HTTP responses', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })));

      await expect(new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels()).rejects.toMatchObject({
        name: 'OllamaConnectorError',
        code: 'unsupported_feature',
        status: 404,
        retryable: false
      });
    });

    it('classifies server errors as retryable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('server error', { status: 500 })));

      await expect(new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels()).rejects.toMatchObject({
        code: 'connector_unavailable',
        status: 500,
        retryable: true
      });
    });

    it('classifies rate limit errors as retryable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('too many requests', { status: 429 })));

      await expect(new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels()).rejects.toMatchObject({
        code: 'rate_limit',
        status: 429,
        retryable: true
      });
    });

    it('classifies timeout status as retryable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('timeout', { status: 408 })));

      await expect(new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels()).rejects.toMatchObject({
        code: 'timeout',
        status: 408,
        retryable: true
      });
    });

    it('classifies authentication errors as non-retryable', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));

      await expect(new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels()).rejects.toMatchObject({
        code: 'authentication_failed',
        status: 401,
        retryable: false
      });
    });

    it('includes response body in error detail when available', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('model not found', { status: 404 })));

      await expect(new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels()).rejects.toMatchObject({
        message: expect.stringContaining('404')
      });
    });
  });

  describe('model metadata and capability discovery', () => {
    it('lists Ollama models with shared metadata fields', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

      const models = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels();

      expect(models).toEqual([
        expect.objectContaining({ id: 'llama3.2:latest', quantization: 'Q4_K_M', maxTokens: 4096 }),
        expect.objectContaining({ id: 'qwen2.5-coder:14b', quantization: 'Q5_K_M', maxTokens: 8192 })
      ]);
    });

    it('infers max tokens from parameter size', async () => {
      const response = {
        models: [
          {
            name: 'small:1b',
            details: { parameter_size: '1B', quantization_level: 'Q4_K_M' }
          },
          {
            name: 'medium:7b',
            details: { parameter_size: '7B', quantization_level: 'Q4_K_M' }
          },
          {
            name: 'large:13b',
            details: { parameter_size: '13B', quantization_level: 'Q5_K_M' }
          }
        ]
      };

      vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));

      const models = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels();

      expect(models[0].maxTokens).toBe(4096);
      expect(models[1].maxTokens).toBe(4096);
      expect(models[2].maxTokens).toBe(8192);
    });

    it('filters out invalid model entries during listing', async () => {
      const response = {
        models: [
          { name: 'valid:latest', details: { quantization_level: 'Q4' } },
          { name: '' },
          { details: { quantization_level: 'Q4' } },
          { name: 'another:latest', details: { quantization_level: 'Q5' } }
        ]
      };

      vi.stubGlobal('fetch', vi.fn(async () => Response.json(response)));

      const models = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels();

      expect(models.length).toBe(2);
      expect(models.map(m => m.id)).toEqual(['valid:latest', 'another:latest']);
    });

    it('discovers full capabilities when Ollama has local models', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

      const discovery = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).discoverCapabilities('request-1');

      expect(discovery).toMatchObject({
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        health: { status: 'ok' },
        capabilities: {
          healthCheck: true,
          modelListing: true,
          chatStreaming: true,
          cancellation: true,
          tokenUsage: true
        },
        models: expect.arrayContaining([
          expect.objectContaining({ id: 'llama3.2:latest' })
        ]),
        failure: null
      });
    });

    it('discovers degraded capabilities when Ollama has no local models', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(emptyOllamaTagsResponse)));

      const discovery = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).discoverCapabilities('request-2');

      expect(discovery).toMatchObject({
        health: { status: 'degraded' },
        capabilities: { healthCheck: true, modelListing: true, chatStreaming: false },
        models: [],
        failure: expect.stringContaining('No local Ollama models')
      });
    });
  });

  describe('health checks and readiness', () => {
    it('reports health from the Ollama tags endpoint', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

      const health = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).getHealth('request-1');

      expect(health).toMatchObject({
        requestId: 'request-1',
        status: 'ok',
        connectorId: 'ollama',
        detail: expect.stringContaining('model')
      });
    });

    it('reports degraded health when models array is missing', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));

      const health = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).getHealth('request-3');

      expect(health).toMatchObject({
        status: 'degraded',
        connectorId: 'ollama'
      });
    });

    it('reports unavailable health when Ollama is unreachable', async () => {
      const error = new Error('Connection refused');
      vi.stubGlobal('fetch', vi.fn(async () => {
        throw error;
      }));

      const health = await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).getHealth('request-4');

      expect(health).toMatchObject({
        status: 'unavailable',
        connectorId: 'ollama',
        detail: expect.stringContaining('Connection refused')
      });
    });
  });

  describe('convenience export functions', () => {
    it('fetchOllamaModels returns empty array on error', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('error', { status: 500 })));

      const models = await fetchOllamaModels('http://localhost:11434');

      expect(models).toEqual([]);
    });

    it('fetchOllamaModels returns models on success', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

      const models = await fetchOllamaModels('http://localhost:11434');

      expect(models).toHaveLength(2);
      expect(models[0].id).toBe('llama3.2:latest');
    });

    it('getOllamaHealth returns health status', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

      const health = await getOllamaHealth('http://localhost:11434');

      expect(health.status).toBe('ok');
      expect(health.connectorId).toBe('ollama');
    });

    it('discoverOllamaCapabilities returns full discovery info', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(ollamaTagsResponse)));

      const discovery = await discoverOllamaCapabilities('http://localhost:11434');

      expect(discovery.provider).toBe('ollama');
      expect(discovery.capabilities.chatStreaming).toBe(true);
      expect(discovery.models.length).toBe(2);
    });
  });

  describe('request streaming with parameters', () => {
    it('sends temperature and max tokens parameters to Ollama', async () => {
      const fetchMock = vi.fn(async () => createNdjsonResponse(toNdjson([
        { message: { role: 'assistant', content: 'test' }, done: true }
      ])));
      vi.stubGlobal('fetch', fetchMock);

      await streamOllamaChat({
        baseUrl: 'http://localhost:11434',
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
        onDelta: () => undefined,
        temperature: 0.7,
        maxTokens: 256
      });

      expect(fetchMock).toHaveBeenCalledWith(
        new URL('http://localhost:11434/api/chat'),
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('temperature')
        })
      );
    });

    it('includes proper content-type and headers in requests', async () => {
      const fetchMock = vi.fn(async () => Response.json(ollamaTagsResponse));
      vi.stubGlobal('fetch', fetchMock);

      await new OllamaConnector({ baseUrl: 'http://localhost:11434' }).listModels();

      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({
          method: 'GET'
        })
      );
    });
  });

  describe('error classification and retry logic', () => {
    it('classifies out-of-memory errors correctly', async () => {
      const chunks = [
        { error: 'out of memory', done: true }
      ];
      
      vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(toNdjson(chunks))));

      await expect(streamOllamaChat({
        baseUrl: 'http://localhost:11434',
        model: 'large-model',
        messages: [{ role: 'user', content: 'test' }],
        onDelta: () => undefined
      })).rejects.toMatchObject({
        code: 'out_of_memory',
        retryable: false
      });
    });

    it('classifies timeout errors correctly', async () => {
      const chunks = [
        { error: 'request timeout', done: true }
      ];
      
      vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(toNdjson(chunks))));

      await expect(streamOllamaChat({
        baseUrl: 'http://localhost:11434',
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
        onDelta: () => undefined
      })).rejects.toMatchObject({
        code: 'timeout',
        retryable: true
      });
    });
  });

  describe('response buffering and streaming edge cases', () => {
    it('handles response with no body gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));

      const connector = new OllamaConnector({ baseUrl: 'http://localhost:11434' });
      
      await expect(connector.streamChat({
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
        onDelta: () => undefined
      })).rejects.toMatchObject({
        code: 'connector_unavailable',
        message: expect.stringContaining('no body')
      });
    });

    it('handles response with only whitespace between chunks', async () => {
      const chunks = [
        { message: { role: 'assistant', content: 'first' }, done: false },
        { message: { role: 'assistant', content: 'second' }, done: true }
      ];
      const ndjson = chunks.map(c => JSON.stringify(c)).join('\n\n  \n') + '\n';
      
      vi.stubGlobal('fetch', vi.fn(async () => createNdjsonResponse(ndjson)));

      const response = await streamOllamaChat({
        baseUrl: 'http://localhost:11434',
        model: 'test-model',
        messages: [{ role: 'user', content: 'test' }],
        onDelta: () => undefined
      });

      expect(response).toBe('firstsecond');
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