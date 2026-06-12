import {
  ADAPTER_PROTOCOL_VERSION,
  AdapterError,
  ChatCompletionRequest,
  ChatCompletionResponse,
  CompletionRequest,
  CompletionResponse,
  EmbeddingsRequest,
  EmbeddingsResponse,
  HealthResponse,
  ModelsResponse,
  ProvenanceRequest,
  ProvenanceResponse,
  StreamingEvent
} from './types';

export interface StreamingSession {
  send(message: string): void;
  close(): void;
  onEvent(listener: (event: StreamingEvent) => void): void;
  onError(listener: (error: unknown) => void): void;
}

export interface StreamingTransportFactory {
  create(url: URL, headers: Record<string, string>): StreamingSession;
}

export interface ModelAdapterClientOptions {
  baseUrl: string;
  apiKey?: string;
  streamingTransportFactory?: StreamingTransportFactory;
  fetchImpl?: typeof fetch;
}

export class ModelAdapterClient {
  private readonly baseUrl: URL;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: ModelAdapterClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async createCompletion(request: CompletionRequest): Promise<CompletionResponse> {
    return this.postJson<CompletionRequest, CompletionResponse>('/v1/completions', request);
  }

  public async createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    return this.postJson<ChatCompletionRequest, ChatCompletionResponse>('/v1/chat/completions', request);
  }

  public async createEmbeddings(request: EmbeddingsRequest): Promise<EmbeddingsResponse> {
    return this.postJson<EmbeddingsRequest, EmbeddingsResponse>('/v1/embeddings', request);
  }

  public async listModels(requestId: string): Promise<ModelsResponse> {
    return this.getJson<ModelsResponse>('/v1/models', requestId);
  }

  public async getHealth(requestId: string): Promise<HealthResponse> {
    return this.getJson<HealthResponse>('/v1/health', requestId);
  }

  public async getProvenance(request: ProvenanceRequest): Promise<ProvenanceResponse> {
    return this.postJson<ProvenanceRequest, ProvenanceResponse>('/v1/provenance', request);
  }

  public openStreamingSession(): StreamingSession {
    if (!this.options.streamingTransportFactory) {
      throw this.createClientError('Streaming transport factory is not configured.');
    }

    const streamUrl = new URL('/v1/stream', this.baseUrl);
    return this.options.streamingTransportFactory.create(streamUrl, this.createHeaders());
  }

  private async getJson<TResponse>(path: string, requestId: string): Promise<TResponse> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: 'GET',
      headers: {
        ...this.createHeaders(),
        'x-request-id': requestId
      }
    });

    return this.parseResponse<TResponse>(response, requestId);
  }

  private async postJson<TRequest, TResponse>(path: string, body: TRequest): Promise<TResponse> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method: 'POST',
      headers: this.createHeaders(),
      body: JSON.stringify(body)
    });

    const requestId = this.extractRequestId(body);
    return this.parseResponse<TResponse>(response, requestId);
  }

  private async parseResponse<TResponse>(response: Response, requestId?: string): Promise<TResponse> {
    if (!response.ok) {
      throw await this.toAdapterError(response, requestId);
    }

    return (await response.json()) as TResponse;
  }

  private createHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-lopilot-protocol-version': ADAPTER_PROTOCOL_VERSION,
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {})
    };
  }

  private extractRequestId(body: unknown): string | undefined {
    if (!body || typeof body !== 'object' || !('requestId' in body)) {
      return undefined;
    }

    const candidate = (body as { requestId?: unknown }).requestId;
    return typeof candidate === 'string' ? candidate : undefined;
  }

  private async toAdapterError(response: Response, requestId?: string): Promise<AdapterError> {
    try {
      const payload = (await response.json()) as Partial<AdapterError>;
      if (payload.code && payload.message && typeof payload.retryable === 'boolean' && payload.source) {
        return {
          code: payload.code,
          message: payload.message,
          retryable: payload.retryable,
          source: payload.source,
          requestId: payload.requestId ?? requestId
        };
      }
    } catch {
      // Ignore invalid JSON and fall through to the default error shape.
    }

    return {
      code: 'connector_unavailable',
      message: `Adapter request failed with status ${response.status}.`,
      retryable: response.status >= 500,
      source: 'http',
      requestId
    };
  }

  private createClientError(message: string): AdapterError {
    return {
      code: 'unsupported_feature',
      message,
      retryable: false,
      source: 'client'
    };
  }
}
