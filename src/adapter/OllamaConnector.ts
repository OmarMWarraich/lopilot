/**
 * Ollama connector — streams responses from the Ollama native `/api/chat` endpoint.
 *
 * The endpoint returns a newline-delimited JSON (NDJSON) stream where each line
 * is a JSON object with the shape:
 *   { model, message: { role, content }, done: boolean, ... }
 *
 * The connector reads the stream line-by-line, calls `onDelta` for each content
 * fragment, and resolves with the accumulated full response text when `done` is
 * true or the stream ends.
 */

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaStreamOptions {
  /** Base URL of the Ollama instance, e.g. `http://localhost:11434` */
  baseUrl: string;
  /** Model identifier, e.g. `solar-pro-preview-instruct-GGUF:Q8_0` */
  model: string;
  /** Conversation history to send */
  messages: OllamaChatMessage[];
  /** Abort signal to cancel an in-flight stream */
  signal?: AbortSignal;
  /** Called for each text delta as it arrives */
  onDelta: (delta: string) => void;
}

/** Shape of a single NDJSON line from Ollama `/api/chat` */
interface OllamaChunk {
  message?: { role?: string; content?: string };
  done: boolean;
  error?: string;
}

/**
 * Streams a chat completion from Ollama and calls `onDelta` for each token.
 *
 * @returns The full accumulated response text.
 * @throws  If the request fails or Ollama returns an error payload.
 */
export async function streamOllamaChat(options: OllamaStreamOptions): Promise<string> {
  const { baseUrl, model, messages, signal, onDelta } = options;

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Ollama request failed (${response.status}): ${detail}`);
  }

  if (!response.body) {
    throw new Error('Ollama response has no body.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      const lines = buffer.split('\n');
      // Keep the last (potentially incomplete) line in the buffer
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let chunk: OllamaChunk;
        try {
          chunk = JSON.parse(trimmed) as OllamaChunk;
        } catch {
          // Malformed line — skip
          continue;
        }

        if (chunk.error) {
          throw new Error(`Ollama error: ${chunk.error}`);
        }

        const delta = chunk.message?.content ?? '';
        if (delta) {
          accumulated += delta;
          onDelta(delta);
        }

        if (chunk.done) {
          return accumulated;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Flush any remaining buffer content
  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer.trim()) as OllamaChunk;
      const delta = chunk.message?.content ?? '';
      if (delta) {
        accumulated += delta;
        onDelta(delta);
      }
    } catch {
      // Ignore
    }
  }

  return accumulated;
}
