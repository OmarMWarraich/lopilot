# Commit Message Directive

When GitHub Copilot is asked to write, suggest, or autofill a commit message for this repository, it must use the format `type(scope): subject`.

Rules:
- Always include a `type`, a `scope`, and a concise `subject`.
- Keep the subject in imperative mood.
- Keep the subject lowercase unless a proper noun requires capitalization.
- Do not end the subject with a period.
- Prefer conventional commit types such as `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `chore`, and `perf`.
- Choose the scope from the area of the repo being changed.
- If the scope cannot be clearly determined from staged file paths, use the closest matching directory name from the repo root.
- If still ambiguous, use `core` as the fallback scope.
- If staged files are configuration or tooling files at the repository root (for example `.gitignore`, `package.json`, or `tsconfig.json`), use `config` as the scope.
- If a change qualifies for more than one type, use the type that best reflects the primary intent in this priority order: `feat` > `fix` > `perf` > `refactor` > `docs` > `test` > `build` > `chore`.

Examples:
- `feat(editor): add monaco smoke test`
- `docs(readme): rewrite project overview`
- `chore(deps): add monaco editor packages`

When there are staged files in the source control view, Copilot should use staged file paths to infer scope for the commit message. For example, if staged files are in `src/editor/`, use `editor`. If staged files are in `docs/`, use `docs`, unless the only changed file is `README.md`, in which case use `readme`. If staged files are in `src/parser/`, use `parser`.

When staged files span multiple areas, Copilot should generate the best single commit message for the currently staged set unless the user explicitly asks for multiple commit messages.


This directive applies whenever Copilot is asked to prepare a commit message, including commit message generation from the Source Control view.