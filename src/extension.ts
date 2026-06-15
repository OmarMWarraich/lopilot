import * as path from 'node:path';
import * as vscode from 'vscode';

import { LopilotPanel } from './chat/LopilotPanel';
import { SessionManager } from './chat/SessionManager';
import { ProviderManager } from './provider/ProviderManager';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionManager = new SessionManager(context.workspaceState);
  await sessionManager.ensureSession();

  const providerManager = new ProviderManager(context.workspaceState);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.name = 'Lopilot';
  statusBarItem.command = 'lopilot.openChat';
  statusBarItem.text = '$(comment-discussion) Lopilot';
  statusBarItem.show();

  const updateStatusBar = () => {
    statusBarItem.tooltip = `Lopilot - ${providerManager.getStateDescription()}`;
  };

  updateStatusBar();

  // Trigger initial discovery and refresh the status bar once it completes
  void providerManager.discoverLocal().then(() => updateStatusBar());

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
      updateStatusBar();
      
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
        const success = await providerManager.setActiveProvider(selected.provider.id);
        updateStatusBar();
        if (success) {
          void vscode.window.showInformationMessage(`Selected provider: ${selected.label}`);
        } else {
          void vscode.window.showErrorMessage(`Could not activate "${selected.label}". The endpoint may be unreachable.`);
        }
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
        const success = await providerManager.enableRemote();
        updateStatusBar();
        if (success) {
          void vscode.window.showInformationMessage('Remote providers are now enabled.');
        } else {
          void vscode.window.showErrorMessage('Could not enable remote providers. Check that a remote endpoint is reachable.');
        }
      }
    }),
    vscode.commands.registerCommand('lopilot.selectModel', async () => {
      const provider = providerManager.getActiveProvider();
      if (!provider) {
        void vscode.window.showWarningMessage('No active provider. Use "Lopilot: Select Provider" first.');
        return;
      }

      if (!providerManager.canSendRequest()) {
        const lifecycleState = providerManager.getLifecycleState();
        if (lifecycleState === 'remote-configured-blocked') {
          void vscode.window.showWarningMessage('Remote provider requests are blocked. Use "Lopilot: Enable Remote Providers" to opt in.');
        } else {
          void vscode.window.showWarningMessage('Provider is not ready. Use "Lopilot: Select Provider" first.');
        }
        return;
      }

      const models = await providerManager.listModels();

      if (models.length === 0) {
        if (provider.type !== 'ollama') {
          void vscode.window.showWarningMessage(`Model selection is currently supported only for Ollama providers (active: ${provider.name}).`);
        } else {
          void vscode.window.showWarningMessage(`No models found on ${provider.name}. Pull a model with \`ollama pull <model>\`.`);
        }
        return;
      }

      const activeModelId = providerManager.getActiveModelId();
      const selected = await vscode.window.showQuickPick(
        models.map((m) => ({
          label: m.displayName,
          description: [m.quantization, m.maxTokens ? `~${m.maxTokens} tokens (est.)` : null].filter(Boolean).join(' · '),
          picked: m.id === activeModelId,
          model: m
        })),
        { placeHolder: 'Select a model' }
      );

      if (selected) {
        await providerManager.setActiveModelId(selected.model.id);
        void vscode.window.showInformationMessage(`Active model: ${selected.label}`);
      }
    })
  );
}

export function deactivate(): void {}