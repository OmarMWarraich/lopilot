import { AdapterErrorCode, HealthResponse, ModelMetadata, TokenUsage } from './types';

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaConnectorOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface OllamaStreamOptions {
  baseUrl: string;
  model: string;
  messages: OllamaChatMessage[];
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  onDelta: (delta: string) => void;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  onDelta: (delta: string) => void;
}

export interface OllamaChatResult {
  model: string;
  content: string;
  usage: TokenUsage;
  doneReason: string | null;
}

export interface OllamaCapabilities {
  healthCheck: boolean;
  modelListing: boolean;
  chatStreaming: boolean;
  cancellation: boolean;
  tokenUsage: boolean;
}

export interface OllamaCapabilityDiscovery {
  provider: 'ollama';
  baseUrl: string;
  health: HealthResponse;
  capabilities: OllamaCapabilities;
  models: ModelMetadata[];
  failure: string | null;
}

export interface OllamaConnectorErrorOptions {
  code: AdapterErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  cause?: unknown;
}

interface OllamaChunk {
  model?: string;
  message?: { role?: string; content?: string };
  done: boolean;
  done_reason?: string;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagEntry {
  name: string;
  modified_at?: string;
  size?: number;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
}

interface OllamaTagsResponse {
  models?: OllamaTagEntry[];
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const DEFAULT_MODEL_TIMEOUT_MS = 5_000;

export class OllamaConnectorError extends Error {
  public readonly code: AdapterErrorCode;
  public readonly retryable: boolean;
  public readonly status?: number;

  public constructor(options: OllamaConnectorErrorOptions) {
    super(options.message);
    this.name = 'OllamaConnectorError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.status = options.status;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class OllamaConnector {
  private readonly baseUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  public constructor(options: OllamaConnectorOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  public async getHealth(requestId = createRequestId(), timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<HealthResponse> {
    try {
      const response = await this.getJson<OllamaTagsResponse>('/api/tags', { timeoutMs });
      return {
        version: 'ollama-native',
        requestId,
        status: Array.isArray(response.models) ? 'ok' : 'degraded',
        connectorId: 'ollama',
        detail: Array.isArray(response.models) ? `${response.models.length} model(s) available` : 'Ollama responded without a model list.'
      };
    } catch (error) {
      return {
        version: 'ollama-native',
        requestId,
        status: 'unavailable',
        connectorId: 'ollama',
        detail: error instanceof Error ? error.message : String(error)
      };
    }
  }

  public async listModels(timeoutMs = DEFAULT_MODEL_TIMEOUT_MS): Promise<ModelMetadata[]> {
    const body = await this.getJson<OllamaTagsResponse>('/api/tags', { timeoutMs });

    if (!Array.isArray(body.models)) {
      throw new OllamaConnectorError({
        code: 'malformed_event',
        message: 'Ollama /api/tags response did not include a models array.',
        retryable: true
      });
    }

    return body.models
      .filter((entry): entry is OllamaTagEntry => typeof entry.name === 'string' && entry.name.length > 0)
      .map(toModelMetadata);
  }

  public async discoverCapabilities(requestId = createRequestId()): Promise<OllamaCapabilityDiscovery> {
    const health = await this.getHealth(requestId);
    if (health.status === 'unavailable') {
      return {
        provider: 'ollama',
        baseUrl: this.baseUrl.origin,
        health,
        capabilities: createUnavailableOllamaCapabilities(),
        models: [],
        failure: health.detail ?? 'Ollama is not reachable.'
      };
    }

    try {
      const models = await this.listModels();
      const hasModels = models.length > 0;
      return {
        provider: 'ollama',
        baseUrl: this.baseUrl.origin,
        health: hasModels ? health : {
          ...health,
          status: 'degraded',
          detail: 'Ollama is reachable, but no local models are installed.'
        },
        capabilities: createOllamaCapabilities(hasModels),
        models,
        failure: hasModels ? null : 'No local Ollama models are installed. Pull a model with `ollama pull <model>` and try again.'
      };
    } catch (error) {
      return {
        provider: 'ollama',
        baseUrl: this.baseUrl.origin,
        health: {
          ...health,
          status: 'degraded',
          detail: error instanceof Error ? error.message : String(error)
        },
        capabilities: { ...createOllamaCapabilities(false), modelListing: false },
        models: [],
        failure: error instanceof Error ? error.message : 'Could not list Ollama models.'
      };
    }
  }

  public async streamChat(request: OllamaChatRequest): Promise<OllamaChatResult> {
    const response = await this.postJsonStream('/api/chat', {
      model: request.model,
      messages: request.messages,
      stream: true,
      options: buildOllamaRequestOptions(request)
    }, {
      signal: request.signal,
      timeoutMs: request.requestTimeoutMs ?? this.requestTimeoutMs
    });

    if (!response.body) {
      throw new OllamaConnectorError({
        code: 'connector_unavailable',
        message: 'Ollama response has no body.',
        retryable: true
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';
    let promptTokens: number | null = null;
    let completionTokens: number | null = null;
    let doneReason: string | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const result = parseOllamaChunk(line);
          if (!result) {
            continue;
          }

          if (result.error) {
            throw new OllamaConnectorError({
              code: classifyOllamaError(result.error),
              message: `Ollama error: ${result.error}`,
              retryable: isRetryableOllamaError(result.error)
            });
          }

          const delta = result.message?.content ?? '';
          if (delta) {
            accumulated += delta;
            request.onDelta(delta);
          }

          promptTokens = result.prompt_eval_count ?? promptTokens;
          completionTokens = result.eval_count ?? completionTokens;
          doneReason = result.done_reason ?? doneReason;

          if (result.done) {
            await reader.cancel().catch(() => undefined);
            return {
              model: result.model ?? request.model,
              content: accumulated,
              usage: buildTokenUsage(promptTokens, completionTokens),
              doneReason
            };
          }
        }
      }

      if (buffer.trim()) {
        const result = parseOllamaChunk(buffer);
        if (result?.error) {
          throw new OllamaConnectorError({
            code: classifyOllamaError(result.error),
            message: `Ollama error: ${result.error}`,
            retryable: isRetryableOllamaError(result.error)
          });
        }
        const delta = result?.message?.content ?? '';
        if (delta) {
          accumulated += delta;
          request.onDelta(delta);
        }
        promptTokens = result?.prompt_eval_count ?? promptTokens;
        completionTokens = result?.eval_count ?? completionTokens;
        doneReason = result?.done_reason ?? doneReason;
      }

      return {
        model: request.model,
        content: accumulated,
        usage: buildTokenUsage(promptTokens, completionTokens),
        doneReason
      };
    } catch (error) {
      if (isAbortError(error)) {
        throw new OllamaConnectorError({
          code: request.signal?.aborted ? 'cancelled' : 'timeout',
          message: request.signal?.aborted ? 'Ollama request was cancelled.' : 'Ollama request timed out.',
          retryable: !request.signal?.aborted,
          cause: error
        });
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private async getJson<TResponse>(path: string, options: RequestOptions = {}): Promise<TResponse> {
    const response = await this.fetchWithTimeout(path, {
      method: 'GET',
      signal: options.signal,
      timeoutMs: options.timeoutMs
    });

    if (!response.ok) {
      throw await toConnectorHttpError(response);
    }

    return parseJsonResponse<TResponse>(response);
  }

  private async postJsonStream(path: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    const response = await this.fetchWithTimeout(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
      timeoutMs: options.timeoutMs
    });

    if (!response.ok) {
      throw await toConnectorHttpError(response);
    }

    return response;
  }

  private async fetchWithTimeout(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const timeoutMs = init.timeoutMs ?? this.requestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abortListener = () => controller.abort();

    if (init.signal?.aborted) {
      clearTimeout(timeout);
      throw new OllamaConnectorError({
        code: 'cancelled',
        message: 'Ollama request was cancelled.',
        retryable: false
      });
    }

    init.signal?.addEventListener('abort', abortListener, { once: true });

    try {
      return await this.fetchImpl(new URL(path, this.baseUrl), {
        ...init,
        signal: controller.signal
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new OllamaConnectorError({
          code: init.signal?.aborted ? 'cancelled' : 'timeout',
          message: init.signal?.aborted ? 'Ollama request was cancelled.' : `Ollama request timed out after ${timeoutMs}ms.`,
          retryable: !init.signal?.aborted,
          cause: error
        });
      }

      throw new OllamaConnectorError({
        code: 'connector_unavailable',
        message: error instanceof Error ? error.message : 'Could not reach Ollama.',
        retryable: true,
        cause: error
      });
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener('abort', abortListener);
    }
  }
}

export async function streamOllamaChat(options: OllamaStreamOptions): Promise<string> {
  const connector = new OllamaConnector({
    baseUrl: options.baseUrl,
    requestTimeoutMs: options.requestTimeoutMs
  });
  const result = await connector.streamChat({
    model: options.model,
    messages: options.messages,
    signal: options.signal,
    requestTimeoutMs: options.requestTimeoutMs,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    onDelta: options.onDelta
  });

  return result.content;
}

export async function fetchOllamaModels(baseUrl: string, timeoutMs = DEFAULT_MODEL_TIMEOUT_MS): Promise<ModelMetadata[]> {
  try {
    return await new OllamaConnector({ baseUrl }).listModels(timeoutMs);
  } catch {
    return [];
  }
}

export async function getOllamaHealth(baseUrl: string, timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS): Promise<HealthResponse> {
  return new OllamaConnector({ baseUrl }).getHealth(createRequestId(), timeoutMs);
}

export async function discoverOllamaCapabilities(baseUrl: string): Promise<OllamaCapabilityDiscovery> {
  return new OllamaConnector({ baseUrl }).discoverCapabilities();
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function normalizeBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new OllamaConnectorError({
      code: 'connector_unavailable',
      message: 'Ollama base URL is required.',
      retryable: false
    });
  }

  const url = new URL(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OllamaConnectorError({
      code: 'connector_unavailable',
      message: `Unsupported Ollama URL protocol: ${url.protocol}`,
      retryable: false
    });
  }

  return url;
}

function buildOllamaRequestOptions(request: Pick<OllamaChatRequest, 'maxTokens' | 'temperature'>): Record<string, number> | undefined {
  const options: Record<string, number> = {};
  if (typeof request.maxTokens === 'number') {
    options.num_predict = request.maxTokens;
  }
  if (typeof request.temperature === 'number') {
    options.temperature = request.temperature;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

function parseOllamaChunk(line: string): OllamaChunk | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<OllamaChunk>;
    if (typeof parsed.done !== 'boolean') {
      throw new Error('missing boolean done field');
    }
    return parsed as OllamaChunk;
  } catch (error) {
    throw new OllamaConnectorError({
      code: 'malformed_event',
      message: `Malformed Ollama stream event: ${trimmed.slice(0, 120)}`,
      retryable: true,
      cause: error
    });
  }
}

async function parseJsonResponse<TResponse>(response: Response): Promise<TResponse> {
  try {
    return (await response.json()) as TResponse;
  } catch (error) {
    throw new OllamaConnectorError({
      code: 'malformed_event',
      message: 'Ollama returned malformed JSON.',
      retryable: true,
      cause: error
    });
  }
}

async function toConnectorHttpError(response: Response): Promise<OllamaConnectorError> {
  const detail = await response.text().catch(() => '');
  const message = detail ? `Ollama request failed (${response.status}): ${detail}` : `Ollama request failed (${response.status}).`;

  return new OllamaConnectorError({
    code: classifyHttpStatus(response.status),
    message,
    retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    status: response.status
  });
}

function toModelMetadata(entry: OllamaTagEntry): ModelMetadata {
  const quantization = entry.details?.quantization_level ?? null;
  const paramSize = entry.details?.parameter_size ?? null;

  let maxTokens: number | null = null;
  if (paramSize) {
    const billions = parseFloat(paramSize);
    if (!Number.isNaN(billions)) {
      maxTokens = billions >= 10 ? 8192 : 4096;
    }
  }

  return {
    id: entry.name,
    displayName: entry.name,
    quantization,
    device: null,
    maxTokens,
    contextWindow: null,
    license: null
  };
}

function buildTokenUsage(promptTokens: number | null, completionTokens: number | null): TokenUsage {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens !== null && completionTokens !== null ? promptTokens + completionTokens : null
  };
}

function createOllamaCapabilities(hasModels: boolean): OllamaCapabilities {
  return {
    healthCheck: true,
    modelListing: true,
    chatStreaming: hasModels,
    cancellation: hasModels,
    tokenUsage: hasModels
  };
}

function createUnavailableOllamaCapabilities(): OllamaCapabilities {
  return {
    healthCheck: false,
    modelListing: false,
    chatStreaming: false,
    cancellation: false,
    tokenUsage: false
  };
}

function classifyHttpStatus(status: number): AdapterErrorCode {
  if (status === 408 || status === 504) {
    return 'timeout';
  }
  if (status === 401 || status === 403) {
    return 'authentication_failed';
  }
  if (status === 429) {
    return 'rate_limit';
  }
  if (status === 404) {
    return 'unsupported_feature';
  }
  return 'connector_unavailable';
}

function classifyOllamaError(message: string): AdapterErrorCode {
  const normalized = message.toLowerCase();
  if (normalized.includes('out of memory') || normalized.includes('memory')) {
    return 'out_of_memory';
  }
  if (normalized.includes('not found')) {
    return 'unsupported_feature';
  }
  if (normalized.includes('timeout')) {
    return 'timeout';
  }
  return 'connector_unavailable';
}

function isRetryableOllamaError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('timeout') || normalized.includes('temporarily') || normalized.includes('busy');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));
}

function createRequestId(): string {
  return `ollama-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
