# Lopilot — VS Code Local-First Chat Extension (Prototype)

Lightweight prototype of a Copilot-style chat & session manager for VS Code. This workspace contains an extension scaffold, a webview-based chat UI, and a workspace-state-backed session store.

## Status
- Scaffold, session manager, webview UI, and core commands implemented.
- Model adapter (chat completions / streaming / RAG) is not yet implemented.

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

## Development notes
- Sessions are persisted using VS Code `workspaceState` (Memento) under the key `lopilot.chat.sessions.v1`.
- The webview client is in `media/chat.js` and `media/chat.css`.
- The extension entry is `src/extension.ts`; session logic lives in `src/chat/SessionManager.ts` and the webview panel in `src/chat/LopilotPanel.ts`.

## Known limitations & next steps
- No model/provider adapter implemented yet — responses are placeholders.
- Add a pluggable model adapter (HTTP/WebSocket), local connector discovery (Ollama/LocalAI), embeddings/vector store and RAG to enable real answers.
- Consider migrating persistence to a durable local DB (SQLite) for larger histories.

## Packaging
Packaging and marketplace publishing are not configured in this prototype. Use `vsce` or `npm run package` if you add packaging scripts.

---
For development questions or to continue implementation, open an issue or run the extension locally as described above.
