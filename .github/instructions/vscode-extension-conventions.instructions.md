---
applyTo: "src/**/*.ts", "media/**/*.js", "esbuild.js"
description: "VS Code extension coding conventions"
---

When editing this repository, follow VS Code extension conventions:

- Prefer idiomatic TypeScript and keep public functions, extension entrypoints, and command handlers explicitly typed.
- Keep activation, command registration, and webview wiring thin; move real behavior into small, focused modules.
- Use the VS Code API directly when it already provides the needed behavior instead of adding custom wrappers.
- Dispose subscriptions, listeners, and webview resources through `context.subscriptions` or the owning lifecycle.
- Guard all editor, workspace, and selection access for empty or undefined states.
- Avoid synchronous filesystem work or blocking work on the extension host.
- Keep webview client code isolated from extension-host code and use clear, typed message payloads between them.
- Preserve the existing code style and naming patterns, and avoid unnecessary abstractions or framework-style layers.
- Add or update tests, type checks, or lightweight validation when behavior changes.
