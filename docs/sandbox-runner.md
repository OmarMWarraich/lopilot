# Sandbox Runner Abstraction

The sandbox runner is the shared execution boundary for tests and future agent actions. It gives feature code a single API for running workspace commands while enforcing approval checkpoints before repository mutations.

## Core Types

- `SandboxRunRequest` describes the command, arguments, working directory, action kind, timeout, repository mutation flag, and optional approval checkpoints.
- `ApprovalCheckpoint` describes a user-visible decision point with title, detail, risk, and whether approval is required.
- `ApprovalProvider` asks the user to approve or reject a checkpoint.
- `SandboxRunner` evaluates checkpoints before spawning a command and returns a structured `SandboxRunResult`.
- `VscodeApprovalProvider` implements approval through modal VS Code warning messages.

## Approval Policy

- Repository mutations require approval before command execution.
- Test runs can be non-interactive when they are read-only, but tests marked as repository-mutating require approval.
- Feature code can add extra checkpoints for high-risk actions such as branch creation, push, merge, or PR creation.
- If any required checkpoint is rejected or dismissed, the command is not spawned and the result status is `rejected`.
- Cancellation before or during execution returns `cancelled`; timeout returns `timeout`.

## Execution Boundary

Commands run through `child_process.spawn` with `shell: false`, a required working directory, bounded stdout/stderr capture, and a default timeout. The runner returns command summaries and redacted-friendly structured results suitable for future audit logging.

The abstraction does not currently provide container isolation. It is a policy and process boundary that can later be backed by an ephemeral process, container, or remote sandbox without changing feature-level call sites.

## Example

```ts
const runner = new SandboxRunner();
const result = await runner.run({
  id: 'test-compile',
  title: 'Run TypeScript compile check',
  kind: 'test',
  command: 'npm',
  args: ['run', 'lint'],
  cwd: workspaceFolder.uri.fsPath,
  timeoutMs: 120000,
  mutatesRepository: false
});
```

For a mutating agent action, set `mutatesRepository: true` and include any additional checkpoints needed by the feature.
