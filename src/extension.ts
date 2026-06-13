import * as path from 'node:path';
import * as vscode from 'vscode';

import { LopilotPanel } from './chat/LopilotPanel';
import { SessionManager } from './chat/SessionManager';
import { ProviderManager } from './provider/ProviderManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionManager = new SessionManager(context.workspaceState);
  await sessionManager.ensureSession();

  const providerManager = new ProviderManager(context.workspaceState);
  // Trigger initial discovery
  void providerManager.discoverLocal();

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.name = 'Lopilot';
  statusBarItem.command = 'lopilot.openChat';
  statusBarItem.text = '$(comment-discussion) Lopilot';
  statusBarItem.tooltip = `Lopilot - ${providerManager.getStateDescription()}`;
  statusBarItem.show();

  context.subscriptions.push(
    statusBarItem,
    vscode.commands.registerCommand('lopilot.openChat', async () => {
      const panel = LopilotPanel.render(context.extensionUri, sessionManager, providerManager);
      await panel.refresh();
    }),
    vscode.commands.registerCommand('lopilot.newSession', async () => {
      await sessionManager.createSession();

      const panel = LopilotPanel.render(context.extensionUri, sessionManager, providerManager);
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

      const panel = LopilotPanel.render(context.extensionUri, sessionManager, providerManager);
      await panel.refresh();
    }),
    vscode.commands.registerCommand('lopilot.discoverProviders', async () => {
      const discovered = await providerManager.discoverLocal();
      
      if (discovered.length === 0) {
        void vscode.window.showWarningMessage('No local providers found. Install Ollama or LocalAI to use local models.');
        return;
      }

      void vscode.window.showInformationMessage(`Found ${discovered.length} local provider(s): ${discovered.map(p => p.name).join(', ')}`);
    }),
    vscode.commands.registerCommand('lopilot.setActiveProvider', async () => {
      const config = providerManager.getConfig();
      const allProviders = [
        ...config.configuredLocal,
        ...config.discoveredLocal,
        ...config.configuredRemote
      ];

      if (allProviders.length === 0) {
        void vscode.window.showWarningMessage('No providers available. Discover or configure a provider first.');
        return;
      }

      const selected = await vscode.window.showQuickPick(
        allProviders.map(p => ({ label: p.name, detail: p.baseUrl, provider: p })),
        { placeHolder: 'Select a provider' }
      );

      if (selected) {
        await providerManager.setActiveProvider(selected.provider.id);
        void vscode.window.showInformationMessage(`Selected provider: ${selected.label}`);
      }
    }),
    vscode.commands.registerCommand('lopilot.enableRemoteProviders', async () => {
      if (providerManager.getConfig().remoteRequestsAllowed) {
        void vscode.window.showInformationMessage('Remote providers are already enabled.');
        return;
      }

      const confirmed = await vscode.window.showWarningMessage(
        'Enable remote provider requests? Code and context will be sent to external servers.',
        'Enable',
        'Cancel'
      );

      if (confirmed === 'Enable') {
        await providerManager.enableRemote();
        void vscode.window.showInformationMessage('Remote providers are now enabled.');
      }
    })
  );
}

export function deactivate(): void {}