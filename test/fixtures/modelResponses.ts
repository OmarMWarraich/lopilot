export const ollamaChatChunks = [
  { message: { role: 'assistant', content: 'Hello' }, done: false },
  { message: { role: 'assistant', content: ', local' }, done: false },
  { message: { role: 'assistant', content: ' model.' }, done: true }
];

export const ollamaErrorChunk = {
  error: 'model not found',
  done: true
};

export const ollamaTagsResponse = {
  models: [
    {
      name: 'llama3.2:latest',
      details: {
        parameter_size: '3.2B',
        quantization_level: 'Q4_K_M'
      }
    },
    {
      name: 'qwen2.5-coder:14b',
      details: {
        parameter_size: '14.7B',
        quantization_level: 'Q5_K_M'
      }
    }
  ]
};

export const emptyOllamaTagsResponse = {
  models: []
};

/**
 * Chat chunks with streaming token counts for testing token accounting
 */
export const ollamaChatChunksWithTokenUsage = [
  {
    message: { role: 'assistant', content: 'Here' },
    prompt_eval_count: 15,
    eval_count: 1,
    done: false
  },
  {
    message: { role: 'assistant', content: ' is' },
    prompt_eval_count: 15,
    eval_count: 2,
    done: false
  },
  {
    message: { role: 'assistant', content: ' code' },
    prompt_eval_count: 15,
    eval_count: 3,
    done: true,
    done_reason: 'stop'
  }
];

/**
 * Simulates a timeout or connectivity error during streaming
 */
export const ollamaChatChunksWithError = [
  { message: { role: 'assistant', content: 'partial response' }, done: false },
  { error: 'connection timeout', done: true }
];

/**
 * Multi-line code generation response
 */
export const ollamaChatChunksMultiline = [
  { message: { role: 'assistant', content: 'function add(a, b) {' }, done: false },
  { message: { role: 'assistant', content: '\n  return a + b;' }, done: false },
  { message: { role: 'assistant', content: '\n}' }, done: true }
];

/**
 * Response with minimal information (no token counts)
 */
export const ollamaChatChunksMinimal = [
  { message: { role: 'assistant', content: 'yes' }, done: true }
];

export function toNdjson(chunks: unknown[]): string {
  return chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + '\n';
}