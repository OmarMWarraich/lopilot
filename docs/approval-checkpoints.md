# Approval Checkpoint Flow

Agent workflows must show explicit approval checkpoints before commands that can mutate the repository, publish changes, or trigger side effects. Feature code should route those commands through `SandboxRunner` with action-specific `ApprovalCheckpoint` entries.

## Common Flow

Every high-risk action follows the same sequence:

1. Build a command plan with a title, command summary, working directory, expected files or repository state affected, and rollback notes when available.
2. Create one or more `ApprovalCheckpoint` records with `required: true` and an appropriate risk level.
3. Call `SandboxRunner.run()` with `mutatesRepository: true` for repository mutations, and add explicit required checkpoints for remote side effects such as PR creation or push.
4. If the user approves every required checkpoint, the runner executes the command and returns a structured result.
5. If any checkpoint is rejected or dismissed, the runner returns `rejected` and must not spawn the command.
6. Record only the approval decision, command summary, relative paths, timestamps, and execution result in the future audit log.

## Branch Creation

Branch creation changes repository state and requires approval.

Required checkpoint:

- `id`: `branch-create`
- `risk`: `medium`
- `detail`: branch name, base branch, current workspace folder, and whether the working tree has pending changes.

Runner request requirements:

- `kind`: `repository-mutation`
- `mutatesRepository`: `true`
- command summary should show `git switch -c <branch>` or equivalent.

The command must not run if the branch name is empty, ambiguous, or hidden from the approval detail.

## Test Execution With Side Effects

Read-only tests can run without modal approval, but tests that write snapshots, update fixtures, start services, run migrations, modify generated files, or alter repository state require approval.

Required checkpoint:

- `id`: `test-side-effects`
- `risk`: `medium`
- `detail`: test command, known write targets, generated output paths, service ports, and cleanup behavior.

Runner request requirements:

- `kind`: `test`
- `mutatesRepository`: `true` when writes or durable side effects are expected.
- include a timeout appropriate for the test suite.

The approval detail should distinguish temporary process side effects from repository mutations.

## PR Creation

Creating a PR publishes branch metadata and possibly generated descriptions to a remote service, so it requires approval even if local files do not change.

Required checkpoint:

- `id`: `pr-create`
- `risk`: `high`
- `detail`: target remote, source branch, base branch, PR title, summary of body content, and whether code snippets are included.

Runner request requirements:

- `kind`: `agent-action`
- `mutatesRepository`: `false` unless the command also modifies local repository state.
- add the `pr-create` checkpoint explicitly because the action publishes data remotely.

The command must not include authentication tokens or full PR body text in audit records.

## Push

Pushing publishes commits to a remote repository and requires approval.

Required checkpoint:

- `id`: `git-push`
- `risk`: `high`
- `detail`: remote name, branch name, commit range or count, force-push status, and upstream target.

Runner request requirements:

- `kind`: `agent-action`
- `mutatesRepository`: `false` for ordinary push because local files are not changed, but the explicit `git-push` checkpoint is required.
- force-push commands require a separate checkpoint with `id: force-push` and clear wording.

The approval detail must call out `--force`, `--force-with-lease`, tag pushes, and multi-ref pushes.

## Merge

Merging changes repository history and working tree state, so it requires approval.

Required checkpoint:

- `id`: `git-merge`
- `risk`: `high`
- `detail`: source ref, target branch, expected strategy, fast-forward behavior, and conflict risk when known.

Runner request requirements:

- `kind`: `repository-mutation`
- `mutatesRepository`: `true`
- command summary should show `git merge <ref>` or equivalent.

The workflow should prefer a dry-run or preview step when practical. If conflicts occur, follow-up commands that resolve files or continue/abort the merge require their own checkpoints.

## Audit Record Shape

Future audit records for these checkpoints should include:

- action category and checkpoint id
- approved or rejected decision
- timestamp
- command summary with secrets redacted
- relative paths or refs affected
- execution status, exit code, and duration

Audit records must not include raw code, complete prompts, secret values, authentication headers, full terminal output, or full PR bodies.
