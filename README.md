# Lopilot — VS Code Local-First Chat Extension (Prototype)

Lightweight prototype of a Copilot-style chat & session manager for VS Code. This workspace contains an extension scaffold, a webview-based chat UI, a workspace-state-backed session store, a local-first provider resolution system, and a typed model-adapter client.

## Status
- Scaffold, session manager, webview UI, and core commands implemented.
- Local-first provider resolution implemented: discovery, configuration, explicit remote opt-in, and a status bar indicator.
- Typed model-adapter client (chat / completions / embeddings / streaming / health / provenance) implemented against a versioned adapter contract.
- Ollama streaming chat is wired into the chat panel; the generic model-adapter client is not wired yet.

## Prerequisites
- Node.js (16+ recommended)
- npm (or compatible yarn)
- Visual Studio Code

## Setup
1. Clone the repo and install dependencies:

```bash
git clone <your-repo-url>
cd lopilot
npm install
```

2. Build the extension bundle:

```bash
npm run lint   # type-check
npm run compile
```

3. (Optional) Run a watch build while developing:

```bash
npm run watch
```

## Run in VS Code
1. Open the project folder in VS Code:

```bash
code .
```

2. Start the Extension Development Host:

- Press `F5` or open the Run view and choose `Launch Extension`.

3. Use the Command Palette (Cmd/Ctrl+Shift+P) and run these commands:

- `Lopilot: Open Chat` — opens the chat webview.
- `Lopilot: New Session` — creates a new chat session.
- `Lopilot: Ask About Selection` — opens chat with the current editor selection preloaded.
- `Lopilot: Discover Local Providers` — scans standard ports for local model servers (e.g. Ollama, LocalAI).
- `Lopilot: Select Provider` — picks an available local or remote provider to activate.
- `Lopilot: Enable Remote Providers` — explicit opt-in required before any remote request is allowed.
- `Lopilot: Select Model` — chooses a model from the active provider (currently Ollama only).

## Provider model (local-first)

Lopilot resolves a model provider before any request is allowed, always preferring local providers and requiring explicit consent for remote ones. Provider state is persisted in `workspaceState` under `lopilot.provider.config.v1`, and the status bar reflects the current state.

The system models five explicit lifecycle states:

- **no-provider** — nothing discovered or configured; requests blocked.
- **local-available** — local provider(s) discovered/configured but none active yet.
- **local-configured** — a specific local provider is active (best for privacy).
- **remote-configured-blocked** — remote provider configured but remote requests not yet enabled; requests blocked by design.
- **remote-enabled** — remote provider active after explicit user opt-in.

Selecting a remote provider never enables remote requests on its own; the user must run `Lopilot: Enable Remote Providers`. If a blocked remote provider is selected and local providers are discovered or configured, the lifecycle state returns to `local-available` so local setup remains the preferred path. See `PROVIDER_IMPLEMENTATION.md` for the full state model and transition rules.

## Development notes
- Sessions are persisted using VS Code `workspaceState` (Memento) under the key `lopilot.chat.sessions.v1`.
- Provider configuration is persisted under `lopilot.provider.config.v1`.
- The webview client is in `media/chat.js` and `media/chat.css`.
- The extension entry is `src/extension.ts`; session logic lives in `src/chat/SessionManager.ts` and the webview panel in `src/chat/LopilotPanel.ts`.
- Provider resolution lives in `src/provider/` (`ProviderState.ts`, `LocalDiscovery.ts`, `ProviderManager.ts`).
- The typed model-adapter client lives in `src/adapter/` (`ModelAdapterClient.ts`, `types.ts`) and targets the contract documented in `docs/adapter-contract.md`. Module boundaries are described in `docs/module-boundaries.md`.

## Known limitations & next steps
- Chat streaming works for Ollama via the native connector; the versioned ModelAdapterClient is not wired into the chat panel yet.
- Wire ModelAdapterClient into LopilotPanel to enable OpenAI-compatible providers and adapter-backed streaming.
- Add embeddings/vector store and RAG to enable grounded answers.
- Consider migrating persistence to a durable local DB (SQLite) for larger histories.

## Packaging
Packaging and marketplace publishing are not configured in this prototype. Use `vsce` or `npm run package` if you add packaging scripts.

---
For development questions or to continue implementation, open an issue or run the extension locally as described above.
