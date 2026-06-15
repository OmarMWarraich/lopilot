export const ollamaChatChunks = [
  { message: { role: 'assistant', content: 'Hello' }, done: false },
  { message: { role: 'assistant', content: ', local' }, done: false },
  { message: { role: 'assistant', content: ' model.' }, done: true }
];

export const ollamaErrorChunk = {
  error: 'model not found',
  done: true
};

export function toNdjson(chunks: unknown[]): string {
  return chunks.map((chunk) => JSON.stringify(chunk)).join('\n') + '\n';
}