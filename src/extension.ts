import * as path from 'node:path';
import * as vscode from 'vscode';

import { LopilotPanel } from './chat/LopilotPanel';
import { SessionManager } from './chat/SessionManager';
import { LopilotInlineCompletionProvider } from './inline';
import { ProviderAvailability, ProviderManager } from './provider/ProviderManager';
import { SharedContextPipeline } from './context';
import { streamOllamaChat } from './adapter';
import { getMockBaseUrl, getMockModels, isE2EMockMode } from './testing/mockRuntime';

const LOPILOT_SETTINGS_SECTION = 'lopilot';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const sessionManager = new SessionManager(context.workspaceState);
  await sessionManager.ensureSession();

  const providerManager = new ProviderManager(context.workspaceState);
  await providerManager.applyPreferences();
  if (isE2EMockMode()) {
    await providerManager.applyPreferences({ force: true });
    const mockModels = getMockModels();
    if (mockModels.length > 0) {
      await providerManager.setActiveModelId(mockModels[0].id);
    }
  }
  const inlineCompletionProvider = LopilotInlineCompletionProvider.register(context, providerManager);

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.name = 'Lopilot';
  statusBarItem.command = 'lopilot.openChat';
  statusBarItem.show();

  const updateStatusBar = () => {
    const lifecycleState = providerManager.getLifecycleState();
    const indicator = getStatusBarIndicator(lifecycleState);
    statusBarItem.text = `${indicator.icon} Lopilot ${indicator.label}`;
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

      const readiness = await providerManager.getActiveProviderReadiness();
      if (readiness.availability !== 'ready') {
        void vscode.window.showWarningMessage(formatProviderReadinessFailure(readiness.availability, readiness.detail));
        return;
      }

      const models = readiness.models;
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
        await vscode.workspace.getConfiguration(LOPILOT_SETTINGS_SECTION).update('defaultModel', selected.model.id, vscode.ConfigurationTarget.Workspace);
        void vscode.window.showInformationMessage(`Active model: ${selected.label}`);
      }
    }),
    vscode.commands.registerCommand('lopilot.configureLocalBackend', async () => {
      const backend = await vscode.window.showQuickPick(
        [{ label: 'Ollama', description: 'Local Ollama server', value: 'ollama' as const }],
        { placeHolder: 'Choose a local backend' }
      );

      if (!backend) {
        return;
      }

      const preferences = providerManager.getPreferences();
      const baseUrl = await vscode.window.showInputBox({
        prompt: 'Ollama base URL',
        value: preferences.ollamaBaseUrl,
        placeHolder: 'http://localhost:11434',
        validateInput: (value) => validateHttpUrl(value)
      });

      if (!baseUrl) {
        return;
      }

      const configuration = vscode.workspace.getConfiguration(LOPILOT_SETTINGS_SECTION);
      await configuration.update('localBackend', backend.value, vscode.ConfigurationTarget.Workspace);
      await configuration.update('ollamaBaseUrl', baseUrl.trim().replace(/\/+$/, ''), vscode.ConfigurationTarget.Workspace);
      const endpoint = await providerManager.applyPreferences({ force: true });
      updateStatusBar();

      if (!endpoint) {
        void vscode.window.showWarningMessage('Could not configure the selected local backend.');
        return;
      }

      const readiness = await providerManager.getActiveProviderReadiness();
      if (readiness.availability !== 'ready') {
        void vscode.window.showWarningMessage(formatProviderReadinessFailure(readiness.availability, readiness.detail));
        return;
      }

      const selectedModel = await vscode.window.showQuickPick(
        readiness.models.map((model) => ({
          label: model.displayName,
          description: [model.quantization, model.maxTokens ? `~${model.maxTokens} tokens (est.)` : null].filter(Boolean).join(' · '),
          picked: model.id === providerManager.getActiveModelId(),
          model
        })),
        { placeHolder: 'Choose the default local model' }
      );

      if (selectedModel) {
        await providerManager.setActiveModelId(selectedModel.model.id);
        await configuration.update('defaultModel', selectedModel.model.id, vscode.ConfigurationTarget.Workspace);
        void vscode.window.showInformationMessage(`Configured ${backend.label} with default model ${selectedModel.label}.`);
      } else {
        void vscode.window.showInformationMessage(`Configured ${backend.label}. Lopilot will use the first available model until you choose a default.`);
      }
    })
  );

  if (isE2EMockMode()) {
    context.subscriptions.push(
      vscode.commands.registerCommand('lopilot.debug.getStateSnapshot', () => {
        return {
          provider: {
            lifecycleState: providerManager.getLifecycleState(),
            stateDescription: providerManager.getStateDescription(),
            canSendRequest: providerManager.canSendRequest(),
            activeProvider: providerManager.getActiveProvider(),
            activeModelId: providerManager.getActiveModelId(),
            mockBaseUrl: getMockBaseUrl()
          },
          chat: sessionManager.getViewModel()
        };
      }),
      vscode.commands.registerCommand('lopilot.debug.sendPrompt', async (prompt: string, contextOptions?: DebugChatContextOptions) => {
        await runDebugPromptFlow(sessionManager, providerManager, prompt, contextOptions);
        return {
          provider: {
            lifecycleState: providerManager.getLifecycleState(),
            canSendRequest: providerManager.canSendRequest(),
            activeProvider: providerManager.getActiveProvider(),
            activeModelId: providerManager.getActiveModelId()
          },
          chat: sessionManager.getViewModel()
        };
      }),
      vscode.commands.registerCommand('lopilot.debug.requestInlineCompletions', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return [];
        }

        const cts = new vscode.CancellationTokenSource();
        try {
          const completions = await inlineCompletionProvider.provideInlineCompletionItems(
            editor.document,
            editor.selection.active,
            { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined },
            cts.token
          );

          return completions?.items ?? [];
        } finally {
          cts.dispose();
        }
      })
    );
  }
}

export function deactivate(): void {}

interface DebugChatContextOptions {
  includeCurrentFile?: boolean;
  includeSelection?: boolean;
  includeRepositoryContext?: boolean;
}

async function runDebugPromptFlow(
  sessionManager: SessionManager,
  providerManager: ProviderManager,
  prompt: string,
  contextOptions?: DebugChatContextOptions
): Promise<void> {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return;
  }

  if (!providerManager.canSendRequest()) {
    await sessionManager.appendAssistantMessage('Mock provider is not ready.');
    return;
  }

  const provider = providerManager.getActiveProvider();
  if (!provider || provider.type !== 'ollama') {
    await sessionManager.appendAssistantMessage('The active provider does not support streaming yet.');
    return;
  }

  const readiness = await providerManager.getActiveProviderReadiness();
  if (readiness.availability !== 'ready') {
    await sessionManager.appendAssistantMessage(formatProviderReadinessFailure(readiness.availability, readiness.detail));
    return;
  }

  await sessionManager.appendUserMessage(trimmedPrompt);

  let modelId = providerManager.getActiveModelId();
  if (!modelId || !readiness.models.some((model) => model.id === modelId)) {
    modelId = readiness.models[0]?.id ?? getMockModels()[0]?.id ?? null;
    if (modelId) {
      await providerManager.setActiveModelId(modelId);
    }
  }

  if (!modelId) {
    await sessionManager.appendAssistantMessage('No model available for mock prompt flow.');
    return;
  }

  const activeSession = sessionManager.getActiveSession();
  const contextPipeline = new SharedContextPipeline();
  const contextBundle = await contextPipeline.build({
    conversation: activeSession?.messages ?? [],
    includeCurrentFile: contextOptions?.includeCurrentFile ?? true,
    includeSelection: contextOptions?.includeSelection ?? true,
    includeRepositoryContext: contextOptions?.includeRepositoryContext ?? true,
    includeConversationState: false
  });

  const history = (sessionManager.getActiveSession()?.messages ?? []).map((message) => ({
    role: message.role as 'user' | 'assistant',
    content: message.content
  }));

  const { messageId } = await sessionManager.beginAssistantStream();

  try {
    const response = await streamOllamaChat({
      baseUrl: provider.baseUrl,
      model: modelId,
      messages: [
        { role: 'system', content: contextPipeline.formatSystemMessage(contextBundle) },
        ...history
      ],
      onDelta: () => undefined
    });

    await sessionManager.finalizeStreamingMessage(messageId, response);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    await sessionManager.finalizeStreamingMessage(messageId, `Error: ${errMsg}`);
  }
}

function formatProviderReadinessFailure(availability: ProviderAvailability, detail: string): string {
  switch (availability) {
    case 'unavailable':
      return `The active provider is unavailable. ${detail}`;
    case 'no-models':
      return detail;
    case 'blocked':
      return `Provider requests are blocked. ${detail}`;
    case 'unsupported':
      return detail;
    case 'not-selected':
      return 'No active provider. Use "Lopilot: Select Provider" first.';
    default:
      return detail;
  }
}

function validateHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'Use an http or https URL.';
    }
    return undefined;
  } catch {
    return 'Enter a valid URL.';
  }
}

function getStatusBarIndicator(lifecycleState: import('./provider/ProviderState').ProviderLifecycleState): { icon: string; label: string } {
  switch (lifecycleState) {
    case 'local-configured':
      return { icon: '$(vm-active)', label: 'Local' };
    case 'remote-configured-blocked':
      return { icon: '$(shield)', label: 'Remote Blocked' };
    case 'remote-enabled':
      return { icon: '$(cloud)', label: 'Remote' };
    case 'local-available':
    case 'no-provider':
    default:
      return { icon: '$(circle-slash)', label: 'Offline' };
  }
}