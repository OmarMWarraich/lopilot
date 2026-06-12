export const ADAPTER_PROTOCOL_VERSION = '2026-06-13';

export type AdapterEndpoint =
  | '/v1/completions'
  | '/v1/chat/completions'
  | '/v1/embeddings'
  | '/v1/models'
  | '/v1/health'
  | '/v1/provenance';

export type AdapterErrorCode =
  | 'rate_limit'
  | 'out_of_memory'
  | 'unsupported_feature'
  | 'authentication_failed'
  | 'connector_unavailable'
  | 'timeout'
  | 'malformed_event'
  | 'cancelled';

export type StreamingEventType =
  | 'stream.start'
  | 'stream.delta'
  | 'stream.error'
  | 'stream.complete'
  | 'stream.cancelled';

export interface TokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface ProvenancePayload {
  modelId: string;
  promptHash: string;
  similarityScore?: number;
  matchedSource?: string;
  matchedLicense?: string;
  requiresAttribution?: boolean;
}

export interface AdapterError {
  code: AdapterErrorCode;
  message: string;
  retryable: boolean;
  source: 'http' | 'stream' | 'connector' | 'client';
  requestId?: string;
}

export interface AdapterResponseBase {
  version: string;
  requestId: string;
}

export interface ModelMetadata {
  id: string;
  displayName: string;
  quantization: string | null;
  device: string | null;
  maxTokens: number | null;
  contextWindow: number | null;
  license: string | null;
}

export interface AdapterRequestMetadata {
  feature?: 'completion' | 'chat' | 'review' | 'agent' | 'embedding';
  workspaceId?: string;
  latencyBudgetMs?: number;
  [key: string]: string | number | boolean | null | undefined;
}

export interface CompletionRequest {
  requestId: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  stream?: boolean;
  metadata?: AdapterRequestMetadata;
}

export interface CompletionCandidate {
  index: number;
  text: string;
  finishReason?: string;
}

export interface CompletionResponse extends AdapterResponseBase {
  model: string;
  candidates: CompletionCandidate[];
  usage: TokenUsage;
  provenance?: ProvenancePayload[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatCompletionRequest {
  requestId: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  stream?: boolean;
  metadata?: AdapterRequestMetadata;
}

export interface ChatCompletionResponse extends AdapterResponseBase {
  model: string;
  message: ChatMessage;
  usage: TokenUsage;
  provenance?: ProvenancePayload[];
}

export interface EmbeddingsRequest {
  requestId: string;
  model: string;
  input: string | string[];
  metadata?: AdapterRequestMetadata;
}

export interface EmbeddingVector {
  index: number;
  embedding: number[];
}

export interface EmbeddingsResponse extends AdapterResponseBase {
  model: string;
  data: EmbeddingVector[];
  usage: TokenUsage;
}

export interface ModelsResponse extends AdapterResponseBase {
  models: ModelMetadata[];
}

export interface HealthResponse extends AdapterResponseBase {
  status: 'ok' | 'degraded' | 'unavailable';
  connectorId?: string;
  detail?: string;
}

export interface ProvenanceRequest {
  requestId: string;
  model: string;
  text: string;
  metadata?: AdapterRequestMetadata;
}

export interface ProvenanceResponse extends AdapterResponseBase {
  model: string;
  entries: ProvenancePayload[];
}

export interface StreamingEventBase {
  version: string;
  requestId: string;
  type: StreamingEventType;
}

export interface StreamStartEvent extends StreamingEventBase {
  type: 'stream.start';
  model: string;
}

export interface StreamDeltaEvent extends StreamingEventBase {
  type: 'stream.delta';
  delta?: string;
  toolStatus?: string;
}

export interface StreamErrorEvent extends StreamingEventBase {
  type: 'stream.error';
  error: AdapterError;
}

export interface StreamCompleteEvent extends StreamingEventBase {
  type: 'stream.complete';
  usage?: TokenUsage;
  provenance?: ProvenancePayload[];
}

export interface StreamCancelledEvent extends StreamingEventBase {
  type: 'stream.cancelled';
}

export type StreamingEvent =
  | StreamStartEvent
  | StreamDeltaEvent
  | StreamErrorEvent
  | StreamCompleteEvent
  | StreamCancelledEvent;
