const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite');
  const workspacePath = path.resolve(__dirname, '../fixtures/e2e-workspace');

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [workspacePath, '--disable-extensions', '--disable-workspace-trust'],
    extensionTestsEnv: {
      LOPILOT_E2E_MOCKS: '1'
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});