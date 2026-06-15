# Testing Infrastructure

Lopilot uses a three-layer baseline test setup with mocked model responses.

## Unit Tests

Unit tests live in `test/unit/` and run with Vitest in Node. They cover pure domain logic and local fixtures without requiring a VS Code Extension Development Host.

```bash
npm run test:unit
```

## Integration Tests

Integration tests live in `test/integration/` and run with Vitest. The initial harness mocks `fetch` and streams Ollama-style NDJSON from `test/fixtures/modelResponses.ts`, so adapter streaming behavior is exercised without a real model server.

```bash
npm run test:integration
```

## End-to-End Tests

E2E scaffolding lives in `test/e2e/` and uses `@vscode/test-electron` to launch an Extension Development Host against `test/fixtures/e2e-workspace`. The runner sets `LOPILOT_E2E_MOCKS=1` so future E2E flows can avoid live model or network dependencies.

```bash
npm run test:e2e
```

## CI Entry Point

`npm test` runs linting, compilation, unit tests, integration tests, and the E2E smoke scaffold. The GitHub Actions workflow in `.github/workflows/ci.yml` uses the same command on push and pull request events.