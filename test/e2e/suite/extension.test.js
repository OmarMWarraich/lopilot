const assert = require('node:assert/strict');
const vscode = require('vscode');

suite('Lopilot E2E smoke suite', () => {
  test('activates the extension and registers baseline commands with mocks enabled', async () => {
    assert.equal(process.env.LOPILOT_E2E_MOCKS, '1');

    const extension = vscode.extensions.getExtension('lopilot.lopilot');
    assert.ok(extension, 'Expected the Lopilot extension to be available in the Extension Development Host.');

    await extension.activate();

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('lopilot.openChat'));
    assert.ok(commands.includes('lopilot.askAboutSelection'));
    assert.ok(commands.includes('lopilot.selectModel'));
    assert.ok(commands.includes('lopilot.cancelInlineCompletion'));
    assert.ok(commands.includes('lopilot.acceptCompletionCandidate'));
    assert.ok(commands.includes('lopilot.cycleCompletionCandidate'));
    assert.ok(commands.includes('lopilot.dismissCompletionCandidates'));
    assert.ok(commands.includes('lopilot.acceptNextInlineEdit'));
  });
});