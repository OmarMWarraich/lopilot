# Shared Context Pipeline

The shared context pipeline gathers bounded workspace context for features that need model input without coupling those features to VS Code editor APIs directly.

## Inputs

- Current file: active editor path, language, line count, dirty state, and bounded text content.
- Selection: active selection text and source line range when a selection exists.
- Neighboring files: nearby text files from the active file's directory, excluding generated and dependency folders.
- Repository signals: workspace name, Git branch from `.git/HEAD`, package name, and package script names when available.
- Conversation state: recent user and assistant turns from the active chat session.

## Output

`SharedContextPipeline.build()` returns a `SharedContextBundle` with normalized `SharedContextItem` entries. `formatSystemMessage()` renders that bundle into a system message suitable for chat adapters and native connectors.

The pipeline applies conservative character limits before context reaches a provider. It is designed to be reused by chat, inline completions, review, and agent workflows.

Context bundles are request-scoped and must not be persisted by the pipeline. See `privacy-rules.md` for persistence and remote-transfer guarantees.

## Current Integration

`LopilotPanel` builds a context bundle immediately before streaming a chat response. The bundle is sent as a system message before the conversation history in the Ollama `/api/chat` request.