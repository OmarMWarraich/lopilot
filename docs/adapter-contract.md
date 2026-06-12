# Lopilot Model Adapter Contract

This document is the protocol contract between the VS Code extension and any local or hosted model connector.

## Versioning

- Protocol version: `2026-06-13`.
- All HTTP responses and streaming events must include a version identifier.
- Backward-incompatible protocol changes require a new protocol version.

## Transport

- HTTP is used for request and response endpoints.
- WebSocket-compatible streaming is represented as typed events correlated by `requestId`.
- Client-initiated cancellation must stop further deltas for the matching `requestId`.

## Endpoints

- `POST /v1/completions`
- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `GET /v1/models`
- `GET /v1/health`
- `POST /v1/provenance`

## Required Request Metadata

- `requestId`: extension-generated identifier used to correlate HTTP and streaming activity.
- `model`: requested model id.
- `workspaceId`: optional workspace identifier.
- `metadata`: optional request metadata such as feature surface, latency budget, or connector hints.

## Streaming Events

- `stream.start`
- `stream.delta`
- `stream.error`
- `stream.complete`
- `stream.cancelled`

### Event Requirements

- Events must be ordered per `requestId`.
- `stream.delta` may carry text deltas, tool/status updates, or model-side annotations.
- `stream.complete` must carry final usage metadata when available.
- `stream.error` must carry a structured error payload.

## Token Accounting

Usage metadata should include:

- `promptTokens`
- `completionTokens`
- `totalTokens`

When a backend cannot provide token counts, it must return `null` values rather than omit the fields.

## Model Metadata

Each model record must include:

- `id`
- `displayName`
- `quantization`
- `device`
- `maxTokens`
- `contextWindow`
- `license`

## Provenance

### MVP Minimum

- `modelId`
- `promptHash`

### Extended Provenance

- `similarityScore`
- `matchedSource`
- `matchedLicense`
- `requiresAttribution`

## Similarity Warning Thresholds

- `0.70` and above: show provenance details inline.
- `0.85` and above: show an explicit high-risk warning and require provenance display before apply or accept actions.
- `0.95` and above: block large-block apply flows until the user explicitly confirms.

## Structured Errors

Each error must include:

- `code`
- `message`
- `retryable`
- `source`
- `requestId`

Required error codes:

- `rate_limit`
- `out_of_memory`
- `unsupported_feature`
- `authentication_failed`
- `connector_unavailable`
- `timeout`
- `malformed_event`
- `cancelled`
