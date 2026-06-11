import * as path from 'node:path';
import * as vscode from 'vscode';

import { LopilotPanel } from './chat/LopilotPanel';
import { SessionManager } from './chat/SessionManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionManager = new SessionManager(context.workspaceState);
  await sessionManager.ensureSession();

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.name = 'Lopilot';
  statusBarItem.command = 'lopilot.openChat';
  statusBarItem.text = '$(comment-discussion) Lopilot';
  statusBarItem.tooltip = 'Open Lopilot chat';
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    vscode.commands.registerCommand('lopilot.openChat', async () => {
      const panel = LopilotPanel.render(context.extensionUri, sessionManager);
      await panel.refresh();
    }),
    vscode.commands.registerCommand('lopilot.newSession', async () => {
      await sessionManager.createSession();

      const panel = LopilotPanel.render(context.extensionUri, sessionManager);
      await panel.refresh();
    }),
    vscode.commands.registerCommand('lopilot.askAboutSelection', async () => {
      const editor = vscode.window.activeTextEditor;

      if (!editor) {
        void vscode.window.showInformationMessage('Open an editor and select code to seed a Lopilot session.');
        return;
      }

      const selectedText = editor.document.getText(editor.selection).trim();

      if (!selectedText) {
        void vscode.window.showInformationMessage('Select some text before asking Lopilot about it.');
        return;
      }

      const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
      const title = `Selection: ${path.basename(relativePath)}`;
      const prompt = [`Selection captured from ${relativePath}:`, '', selectedText].join('\n');

      await sessionManager.createSession({
        title,
        initialUserMessage: prompt
      });
      await sessionManager.appendAssistantMessage(
        'Selection context captured. Model adapters, streaming responses, and retrieval wiring come next.'
      );

      const panel = LopilotPanel.render(context.extensionUri, sessionManager);
      await panel.refresh();
    })
  );
}

export function deactivate(): void {}