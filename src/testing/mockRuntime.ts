import type { ModelMetadata } from '../adapter/types';
import type { OllamaChatMessage, OllamaChatResult, OllamaChatRequest } from '../adapter/OllamaConnector';

const MOCK_MODEL_ID = 'mock-coder:latest';
const MOCK_BASE_URL = 'http://localhost:11434';

export function isE2EMockMode(): boolean {
  return process.env.LOPILOT_E2E_MOCKS === '1';
}

export function getMockBaseUrl(): string {
  return MOCK_BASE_URL;
}

export function getMockModels(): ModelMetadata[] {
  return [
    {
      id: MOCK_MODEL_ID,
      displayName: 'Mock Coder',
      quantization: 'Q4_K_M',
      device: null,
      maxTokens: 4096,
      contextWindow: 8192,
      license: 'mock'
    }
  ];
}

export async function streamMockChat(request: OllamaChatRequest): Promise<OllamaChatResult> {
  const content = buildMockResponse(request.messages);
  const deltas = splitIntoDeltas(content);

  for (const delta of deltas) {
    if (request.signal?.aborted) {
      throw new Error('mock chat aborted');
    }
    if (delta) {
      request.onDelta(delta);
    }
  }

  const promptTokens = estimatePromptTokens(request.messages);
  const completionTokens = Math.max(1, Math.ceil(content.length / 4));

  return {
    model: request.model || MOCK_MODEL_ID,
    content,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    },
    doneReason: 'stop'
  };
}

function buildMockResponse(messages: OllamaChatMessage[]): string {
  const systemMessage = messages.find((message) => message.role === 'system')?.content ?? '';
  const lastUserMessage = [...messages].reverse().find((message) => message.role === 'user')?.content ?? '';

  if (systemMessage.includes('inline code completion engine')) {
    return '42';
  }

  if (lastUserMessage.includes('Selection captured from')) {
    return 'Mock response based on the captured selection.';
  }

  const normalizedPrompt = lastUserMessage.replace(/\s+/g, ' ').trim();
  const summary = normalizedPrompt.length > 60 ? `${normalizedPrompt.slice(0, 57).trimEnd()}...` : normalizedPrompt;
  return `Mock response for: ${summary || 'empty prompt'}`;
}

function splitIntoDeltas(content: string): string[] {
  const deltas: string[] = [];
  for (let index = 0; index < content.length; index += 12) {
    deltas.push(content.slice(index, index + 12));
  }
  return deltas.length > 0 ? deltas : [''];
}

function estimatePromptTokens(messages: OllamaChatMessage[]): number {
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  return Math.max(1, Math.ceil(totalChars / 4));
}