# Lopilot — VS Code Local-First Chat Extension

Lopilot is a local-first VS Code assistant prototype. It combines a webview chat UI, workspace-scoped chat sessions, local provider discovery, Ollama streaming, shared context collection, privacy rules, approval checkpoints, and a baseline mocked test stack.

The project is scaffolded around clear module boundaries so chat, inline completions, review tooling, and future agent workflows can share provider, context, adapter, and sandbox primitives without being tightly coupled.

## Current Features

- VS Code extension scaffold with command registration, status bar integration, launch configuration, and esbuild bundling.
- Webview chat panel with sessions persisted in VS Code `workspaceState`.
- Inline editor completions for active Ollama providers, with request cancellation, multiple candidates, partial token preview decorations, and stable final ghost-text rendering.
- Native diff previews for active inline candidates before accepting generated changes.
- `Ask About Selection` command that starts a chat session from the active editor selection.
- Local-first provider resolution with explicit lifecycle states for no provider, local available, local configured, remote configured but blocked, and remote enabled.
- Local provider discovery for common Ollama and LocalAI-compatible endpoints.
- Explicit remote-provider opt-in before remote requests are allowed.
- Ollama `/api/chat` streaming connector with incremental webview updates.
- Model selection for active Ollama providers via `Lopilot: Select Model`.
- Shared context pipeline for current file, active selection, neighboring files, repository signals, and recent conversation state.
- Typed model-adapter client for completions, chat completions, embeddings, models, health, and provenance endpoints.
- Sandbox runner abstraction for tests and future agent actions, including approval checkpoints before repository mutations.
- Privacy, approval-flow, provider, adapter, context, sandbox, and testing documentation.
- Baseline unit, integration, and VS Code E2E test infrastructure using mocked model responses.
- GitHub Actions CI that runs linting, compilation, unit tests, integration tests, and E2E smoke tests.

## Prerequisites

- Node.js 22 recommended for development and CI parity.
- npm.
- Visual Studio Code.
- Optional: Ollama running locally for live chat streaming.

## Setup

```bash
git clone https://github.com/OmarMWarraich/lopilot.git
cd lopilot
npm install
```

Build and type-check the extension:

```bash
npm run lint
npm run compile
```

Run a watch build while developing:

```bash
npm run watch
```

## Running In VS Code

1. Open the project in VS Code.
2. Press `F5`, or open the Run view and choose `Launch Extension`.
3. In the Extension Development Host, open the Command Palette and run Lopilot commands.

Available commands:

- `Lopilot: Open Chat` — opens the chat webview.
- `Lopilot: New Session` — creates a new chat session.
- `Lopilot: Ask About Selection` — opens chat with the current editor selection preloaded.
- `Lopilot: Discover Local Providers` — scans standard local model server ports.
- `Lopilot: Select Provider` — selects an available local or remote provider.
- `Lopilot: Enable Remote Providers` — explicitly enables remote requests after user confirmation.
- `Lopilot: Select Model` — chooses a model from the active provider, currently Ollama only.
- `Lopilot: Cancel Inline Completion` — cancels the active inline completion stream and clears partial preview text.
- `Lopilot: Accept Completion Candidate` — accepts the active Lopilot inline candidate.
- `Lopilot: Cycle Completion Candidate` — previews the next generated inline candidate.
- `Lopilot: Dismiss Completion Candidates` — clears the active candidate session.
- `Lopilot: Accept Next Inline Edit` — accepts the next line or token chunk from the active candidate and keeps the remainder available.
- `Lopilot: Preview Inline Diff` — opens the active inline candidate in VS Code's diff editor before accepting it.

## Ollama Workflow

For live local chat responses:

```bash
ollama serve
ollama pull <model>
```

Then run:

1. `Lopilot: Discover Local Providers`.
2. `Lopilot: Select Provider` and choose the discovered Ollama endpoint.
3. `Lopilot: Select Model` and choose an installed model.
4. `Lopilot: Open Chat` and send a prompt.

When no model is selected, Lopilot falls back to the first available model reported by Ollama. If the stored model id is stale, it is replaced with an available model before streaming.

## Local-First Provider Model

Provider state is persisted under `lopilot.provider.config.v1` in VS Code `workspaceState`. Lopilot prefers local providers and blocks remote requests until the user explicitly opts in.

Lifecycle states:

- `no-provider` — nothing discovered or configured; requests are blocked.
- `local-available` — local provider(s) discovered or configured, but none active yet.
- `local-configured` — a local provider is active and requests may be sent locally.
- `remote-configured-blocked` — a remote provider is configured or selected, but remote requests are blocked.
- `remote-enabled` — a remote provider is active after explicit user opt-in.

Selecting a remote provider does not enable remote usage. If a blocked remote is selected while local providers are available, local setup remains the preferred path. Full transition details live in [PROVIDER_IMPLEMENTATION.md](PROVIDER_IMPLEMENTATION.md).

## Shared Context

The shared context pipeline lives in `src/context/`. It captures bounded, request-scoped context from:

- current file
- active selection
- neighboring text files
- repository signals such as workspace name, Git branch, package name, and package scripts
- recent conversation turns

Chat currently sends this bundle as a system message before conversation history in the Ollama request. See [docs/context-pipeline.md](docs/context-pipeline.md).

## Adapter Layer

The typed adapter client lives in `src/adapter/` and targets the versioned contract in [docs/adapter-contract.md](docs/adapter-contract.md). It includes client methods and types for:

- `/v1/completions`
- `/v1/chat/completions`
- `/v1/embeddings`
- `/v1/models`
- `/v1/health`
- `/v1/provenance`

The generic `ModelAdapterClient` is implemented but not yet wired into the chat panel; chat streaming currently uses Ollama's native API.

## Sandbox And Approval Checkpoints

The `src/agent/` module provides a sandbox runner abstraction for tests and future agent workflows. It runs commands through a single execution boundary, captures bounded output, supports cancellation and timeouts, and requires approval checkpoints before repository mutations.

Related docs:

- [docs/sandbox-runner.md](docs/sandbox-runner.md)
- [docs/approval-checkpoints.md](docs/approval-checkpoints.md)
- [docs/privacy-rules.md](docs/privacy-rules.md)

## Testing

Lopilot has baseline unit, integration, and E2E test infrastructure with mocked model responses.

```bash
npm run lint
npm run lint:tests
npm run test:unit
npm run test:integration
npm run test:e2e
npm test
```

Test layers:

- Unit tests live in `test/unit/` and run with Vitest.
- Integration tests live in `test/integration/` and use mocked Ollama NDJSON streaming responses from `test/fixtures/modelResponses.ts`.
- E2E scaffolding lives in `test/e2e/` and uses `@vscode/test-electron` against `test/fixtures/e2e-workspace` with `LOPILOT_E2E_MOCKS=1`.
- `npm test` runs linting, test type-checking, compilation, unit tests, integration tests, and E2E smoke tests.

CI runs the same `npm test` entry point in GitHub Actions using `xvfb-run` for VS Code E2E execution. See [docs/testing.md](docs/testing.md) and [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Project Layout

- `src/extension.ts` — extension activation, command registration, status bar wiring.
- `src/inline/` — inline completion provider, prompt assembly, candidate workflows, cancellation, and editor preview rendering.
- `src/chat/` — chat panel and session persistence.
- `src/provider/` — provider discovery, lifecycle state, model listing, and local-first routing.
- `src/context/` — shared request-scoped context collection.
- `src/adapter/` — versioned adapter client and protocol types.
- `src/agent/` — sandbox runner and approval abstractions.
- `media/` — webview JavaScript and CSS.
- `docs/` — architecture, privacy, adapter, context, sandbox, approval, and testing docs.
- `test/` — unit, integration, E2E scaffolding, and fixtures.

Module boundaries are documented in [docs/module-boundaries.md](docs/module-boundaries.md).

## Privacy

Lopilot treats code context as request-scoped unless the user explicitly persists content through chat. Provider configuration and chat sessions are workspace-scoped, remote provider usage requires explicit consent, and future audit logs must avoid raw code, full prompts, secrets, and unredacted terminal output by default.

See [docs/privacy-rules.md](docs/privacy-rules.md).

## Known Limitations

- Inline completions currently use the active Ollama provider through the native chat stream; the generic adapter client is not wired into inline completions yet.
- Chat streaming is currently Ollama-specific; the generic adapter client is not wired into chat yet.
- LocalAI and generic OpenAI-compatible streaming connectors are planned but not implemented.
- The sandbox runner is currently a policy and process boundary, not container isolation.
- Provider management UI is command-palette based; richer configuration UI is future work.
- E2E tests are smoke scaffolding with mocks, not full chat workflow coverage yet.

## Packaging

Packaging and marketplace publishing are not configured in this prototype. `npm run package` creates a production bundle with esbuild, but VSIX publishing metadata and release automation still need to be added.
