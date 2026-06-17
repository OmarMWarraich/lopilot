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
    assert.ok(commands.includes('lopilot.configureLocalBackend'));
    assert.ok(commands.includes('lopilot.selectModel'));
    assert.ok(commands.includes('lopilot.cancelInlineCompletion'));
    assert.ok(commands.includes('lopilot.acceptCompletionCandidate'));
    assert.ok(commands.includes('lopilot.cycleCompletionCandidate'));
    assert.ok(commands.includes('lopilot.dismissCompletionCandidates'));
    assert.ok(commands.includes('lopilot.acceptNextInlineEdit'));
  });

  test('auto-configures a mocked local provider in CI mode', async () => {
    const extension = vscode.extensions.getExtension('lopilot.lopilot');
    assert.ok(extension);
    await extension.activate();

    const snapshot = await vscode.commands.executeCommand('lopilot.debug.getStateSnapshot');

    assert.equal(snapshot.provider.lifecycleState, 'local-configured');
    assert.equal(snapshot.provider.canSendRequest, true);
    assert.equal(snapshot.provider.activeProvider.type, 'ollama');
    assert.equal(snapshot.provider.activeProvider.baseUrl, 'http://localhost:11434');
    assert.equal(snapshot.provider.activeModelId, 'mock-coder:latest');
  });

  test('captures selection into a session via ask-about-selection', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'main.ts'));
    const editor = await vscode.window.showTextDocument(document);
    const start = document.getText().indexOf('left + right');
    const selectionStart = document.positionAt(start);
    const selectionEnd = document.positionAt(start + 'left + right'.length);

    editor.selection = new vscode.Selection(selectionStart, selectionEnd);
    await vscode.commands.executeCommand('lopilot.askAboutSelection');

    const snapshot = await vscode.commands.executeCommand('lopilot.debug.getStateSnapshot');
    assert.ok(snapshot.chat.activeSession);
    assert.match(snapshot.chat.activeSession.title, /Selection: main\.ts/);
    assert.equal(snapshot.chat.activeSession.messages[0].role, 'user');
    assert.match(snapshot.chat.activeSession.messages[0].content, /left \+ right/);
    assert.equal(snapshot.chat.activeSession.messages[1].role, 'assistant');
  });

  test('runs a mocked chat prompt flow end to end', async () => {
    const result = await vscode.commands.executeCommand('lopilot.debug.sendPrompt', 'Summarize the current file briefly.');

    const messages = result.chat.activeSession.messages;
    assert.equal(messages[messages.length - 2].role, 'user');
    assert.equal(messages[messages.length - 2].content, 'Summarize the current file briefly.');
    assert.equal(messages[messages.length - 1].role, 'assistant');
    assert.match(messages[messages.length - 1].content, /Mock response for:/);
  });

  test('returns mocked inline completions through the registered provider', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri, 'main.ts'));
    const editor = await vscode.window.showTextDocument(document);
    const completionLine = document.lineAt(document.lineCount - 1);
    const position = new vscode.Position(document.lineCount - 1, completionLine.text.length);

    editor.selection = new vscode.Selection(position, position);

    const items = await vscode.commands.executeCommand('lopilot.debug.requestInlineCompletions');
    assert.ok(items.length > 0);
    assert.equal(items[0].insertText, '42');
  });
});