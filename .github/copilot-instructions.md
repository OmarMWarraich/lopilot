# Commit Message Directive

When GitHub Copilot is asked to write, suggest, or autofill a commit message for this repository, it must use the format `type(scope): subject`.

Rules:
- Always include a `type`, a `scope`, and a concise `subject`.
- Keep the subject in imperative mood.
- Keep the subject lowercase unless a proper noun requires capitalization.
- Do not end the subject with a period.
- Prefer conventional commit types such as `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `chore`, and `perf`.
- Choose the scope from the area of the repo being changed when it is clear, for example `editor`, `mindmap`, `parser`, `layout`, `readme`, or `deps`.

Examples:
- `feat(editor): add monaco smoke test`
- `docs(readme): rewrite project overview`
- `chore(deps): add monaco editor packages`

This directive applies whenever Copilot is asked to prepare a commit message, including commit message generation from the Source Control view.