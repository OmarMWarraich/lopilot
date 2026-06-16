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

export function toNdjson(chunks: unknown[]): string {
  return chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + '\n';
}