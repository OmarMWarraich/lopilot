# Privacy Rules

Lopilot is local-first by default. These rules define how code context, metadata, and future agent audit records are handled across local and remote provider flows.

## Request Lifetime

- Code context from the current file, active selection, neighboring files, and repository signals is assembled only when a feature makes a model request.
- Shared context bundles are in-memory request payloads. They are not written to workspace storage, global storage, logs, or audit records by the context pipeline.
- Context sent to a local provider remains within the local provider boundary configured by the user, subject to that provider's own runtime behavior.
- Context sent to a remote provider is allowed only after explicit user opt-in through the remote-provider consent flow.
- Failed, cancelled, and completed requests must release request-scoped context after the request handler finishes.

## Persistence Boundaries

Lopilot persists only the state needed to restore extension behavior.

| Data | Location | Contents | Code Content Allowed |
| --- | --- | --- | --- |
| Chat sessions | `workspaceState` key `lopilot.chat.sessions.v1` | User and assistant chat messages, session titles, timestamps | Yes, only when the user sends or stores it as chat content |
| Provider configuration | `workspaceState` key `lopilot.provider.config.v1` | Provider endpoints, active provider/model ids, discovery timestamps, remote consent flag | No |
| Shared context bundles | Memory only | Current request's bounded file, selection, neighboring file, repository, and conversation context | Yes, request-scoped only |
| API keys and provider secrets | VS Code `SecretStorage` | Secret values or secret references for authenticated providers | No code content |
| Agent audit log | Future local audit store under workspace-specific extension storage | Intent, approvals, command summaries, changed-file paths, result metadata, timestamps | No raw code or full prompts by default |

Do not store raw file snapshots, selections, neighboring file contents, prompt bundles, model request bodies, or model response bodies outside chat/session persistence unless a future feature explicitly documents the storage purpose and obtains user-facing consent.

## Metadata Retention

- Provider metadata may include endpoint ids, endpoint names, provider type, base URL, discovery time, active model id, and remote consent state.
- Repository metadata may include workspace name, relative paths, Git branch, package name, package script names, feature name, request id, and high-level status.
- Metadata must use relative workspace paths where possible.
- Metadata must not include raw code, secrets, full prompts, access tokens, API keys, environment variable values, or remote response bodies.
- Metadata retained for diagnostics or future audit records should be minimized to what is needed to explain user-visible behavior.

## Agent Audit Log Contents

When agent workflows are implemented, the local audit log should record:

- The requested action category, such as branch creation, test execution, file edit, PR creation, push, or merge.
- The user's approval decision and timestamp for each risky step.
- The command or mutation summary, using redacted arguments when secrets may be present.
- Relative file paths touched or proposed, without storing raw before/after file contents.
- Execution status, exit code, duration, and concise error summaries.
- Provider id, model id, feature name, and request id when relevant.

The audit log must not record raw code blocks, complete prompts, complete model responses, secret values, authentication headers, environment dumps, or terminal output that may contain secrets. If a future workflow needs richer evidence, it must store explicit redacted artifacts and make the persistence behavior visible in documentation.

## Remote-Transfer Consent

- Remote provider requests are blocked unless `remoteRequestsAllowed` is true in provider configuration.
- Selecting or configuring a remote provider does not grant consent by itself.
- The consent prompt must explain that code and context can be sent to external servers.
- Local providers remain preferred when available; a blocked remote provider must not silently override local provider setup.
- Disabling remote providers must prevent future remote requests and clear active remote routing where applicable.
- Remote consent is workspace-scoped because provider configuration is stored in `workspaceState`.

## Implementation Checklist

- Keep shared context request-scoped unless the user explicitly sends it as a chat message.
- Store provider secrets only in VS Code `SecretStorage`.
- Store provider state and chat sessions only in workspace-scoped `Memento` keys.
- Prefer relative paths in metadata and audit records.
- Redact command arguments, environment data, and provider headers before logging.
- Require explicit approval before any future agent action that mutates the repository or transfers code to remote services.