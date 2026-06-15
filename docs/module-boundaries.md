# Lopilot Module Boundaries

This document defines the extension module boundaries, dependency rules, and intended source layout for the Lopilot extension.

## Dependency Rules

- Feature modules may depend on `context`, `provider`, and `adapter`.
- Feature modules must not import each other directly.
- Shared behavior must live in `context`, `provider`, `adapter`, or another explicitly shared package.
- The `provider` layer may depend on `adapter` contracts, but not on feature modules.
- The `context` layer must not depend on feature modules.
- The `adapter` layer is transport-only and must not depend on UI concerns.

## Intended Source Layout

- `src/completions/`: inline completion orchestration, candidate ranking, accept and dismiss flows, inline diff preview.
- `src/chat/`: chat panel rendering, session lifecycle, chat message orchestration.
- `src/review/`: changed-file ingestion, PR summary generation, review comments, suggested fixes.
- `src/agent/`: repository-scoped task orchestration, approval checkpoints, sandbox execution, audit logging.
- `src/provider/`: model connectors, provider discovery, provider resolution, health checks, capability metadata.
- `src/context/`: current file, selection, neighboring files, repository signals, and conversation state builders.
- `src/adapter/`: protocol types, HTTP clients, streaming transport contracts, structured error handling.

## Module Responsibilities

### Completions

- Requests inline completions from adapter-backed providers.
- Ranks and presents multiple candidates.
- Handles acceptance, cycling, dismissal, and next-edit workflows.

### Chat

- Owns chat panel lifecycle and session state presentation.
- Requests streaming chat responses through the adapter layer.
- Applies file, selection, and repository context toggles.

### Review

- Ingests changed files and diffs.
- Produces PR summaries, targeted review comments, and suggested fixes.

### Agent

- Coordinates repository-scoped actions under approval.
- Delegates execution to sandboxed runners and records audit events.
- Stores audit records according to the privacy rules, excluding raw code, full prompts, secrets, and unredacted terminal output by default.

### Provider

- Registers local and hosted providers.
- Exposes capability metadata, health state, and model discovery results.
- Resolves the active provider using local-first routing rules.

### Context

- Collects and normalizes editor, workspace, and conversation context.
- Produces reusable context payloads for completions, chat, review, and agent flows.
- Owns shared context size limits so providers receive bounded current-file, selection, neighboring-file, repository, and conversation inputs.
- Keeps generated context bundles request-scoped unless the user explicitly persists content through a feature such as chat.

### Adapter

- Defines transport contracts, request and response types, streaming event types, and structured errors.
- Implements HTTP endpoint clients and streaming transport integration.
