import * as vscode from 'vscode';

import { streamOllamaChat } from '../adapter';
import { SharedContextPipeline } from '../context';
import { SessionManager } from './SessionManager';
import { ProviderManager } from '../provider/ProviderManager';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'sendPrompt'; prompt: string; contextOptions?: ChatContextOptions };

interface ChatContextOptions {
  includeCurrentFile: boolean;
  includeSelection: boolean;
  includeRepositoryContext: boolean;
}

const DEFAULT_CHAT_CONTEXT_OPTIONS: ChatContextOptions = {
  includeCurrentFile: true,
  includeSelection: true,
  includeRepositoryContext: true
};

export class LopilotPanel {
  private static currentPanel: LopilotPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private isReady = false;
  private readonly contextPipeline = new SharedContextPipeline();

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager,
    private readonly providerManager: ProviderManager
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.registerListeners();
  }

  public static render(
    extensionUri: vscode.Uri,
    sessionManager: SessionManager,
    providerManager: ProviderManager
  ): LopilotPanel {
    if (LopilotPanel.currentPanel) {
      LopilotPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return LopilotPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel('lopilot.chat', 'Lopilot Chat', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    });

    LopilotPanel.currentPanel = new LopilotPanel(panel, extensionUri, sessionManager, providerManager);
    return LopilotPanel.currentPanel;
  }

  public async refresh(): Promise<void> {
    if (!this.isReady) {
      return;
    }

    await this.panel.webview.postMessage({
      type: 'state',
      payload: {
        chat: this.sessionManager.getViewModel(),
        provider: {
          state: this.providerManager.getLifecycleState(),
          stateDescription: this.providerManager.getStateDescription(),
          canSendRequest: this.providerManager.canSendRequest(),
          activeProvider: this.providerManager.getActiveProvider(),
          indicator: toConnectionIndicator(this.providerManager.getLifecycleState())
        }
      }
    });
  }

  private registerListeners(): void {
    this.panel.onDidDispose(() => {
      LopilotPanel.currentPanel = undefined;
    });

    this.panel.webview.onDidReceiveMessage(
      async (message: WebviewMessage) => {
        switch (message.type) {
          case 'ready': {
            this.isReady = true;
            await this.refresh();
            return;
          }
          case 'newSession': {
            await this.sessionManager.createSession();
            await this.refresh();
            return;
          }
          case 'selectSession': {
            await this.sessionManager.setActiveSession(message.sessionId);
            await this.refresh();
            return;
          }
          case 'sendPrompt': {
            const prompt = message.prompt.trim();
            const contextOptions = normalizeChatContextOptions(message.contextOptions);

            if (!prompt) {
              return;
            }

            if (!this.providerManager.canSendRequest()) {
              const lifecycleState = this.providerManager.getLifecycleState();
              let blockedMessage: string;
              switch (lifecycleState) {
                case 'local-available':
                  blockedMessage = 'A local provider was discovered but not yet selected. Use "Lopilot: Select Provider" to activate it.';
                  break;
                case 'remote-configured-blocked':
                  blockedMessage = 'A remote provider is configured but remote requests are not yet enabled. Use "Lopilot: Enable Remote Providers" to opt in.';
                  break;
                case 'no-provider':
                default:
                  blockedMessage = 'No provider is configured. Use "Lopilot: Select Provider" to set up a local or remote provider.';
                  break;
              }
              await this.sessionManager.appendAssistantMessage(blockedMessage);
              await this.refresh();
              return;
            }

            await this.sessionManager.appendUserMessage(prompt);
            // Optimistically update the webview so the user's message appears immediately
            await this.refresh();

            const provider = this.providerManager.getActiveProvider();

            if (!provider || provider.type !== 'ollama') {
              await this.sessionManager.appendAssistantMessage(
                'The active provider does not support streaming yet. Select an Ollama provider via "Lopilot: Select Provider".'
              );
              await this.refresh();
              return;
            }

            const readiness = await this.providerManager.getActiveProviderReadiness();
            if (readiness.availability !== 'ready') {
              await this.sessionManager.appendAssistantMessage(formatProviderReadinessFailure(readiness.availability, readiness.detail));
              await this.refresh();
              return;
            }

            if (!readiness.capabilities.chatStreaming) {
              await this.sessionManager.appendAssistantMessage('The active provider is reachable, but it does not currently support streaming chat requests.');
              await this.refresh();
              return;
            }

            const models = readiness.models;
            let modelId = this.providerManager.getActiveModelId();
            // If the stored active model is missing on the instance, fall back to the first available model
            if (!modelId || !models.some((m) => m.id === modelId)) {
              modelId = models[0].id;
              await this.providerManager.setActiveModelId(modelId);
            }

            // Build message history with shared workspace context
            const activeSession = this.sessionManager.getActiveSession();
            const contextBundle = await this.contextPipeline.build({
              conversation: activeSession?.messages ?? [],
              includeCurrentFile: contextOptions.includeCurrentFile,
              includeSelection: contextOptions.includeSelection,
              includeRepositoryContext: contextOptions.includeRepositoryContext,
              includeConversationState: false
            });
            const history = (activeSession?.messages ?? []).map((message) => ({
              role: message.role as 'user' | 'assistant',
              content: message.content,
            }));
            const messages = [
              { role: 'system' as const, content: this.contextPipeline.formatSystemMessage(contextBundle) },
              ...history
            ];

            // Create a streaming placeholder and signal start to the webview
            const { messageId } = await this.sessionManager.beginAssistantStream();
            await this.panel.webview.postMessage({
              type: 'stream.start',
              messageId,
              contextSummary: summarizeContextBundle(contextBundle)
            });

            let accumulated = '';
            try {
              accumulated = await streamOllamaChat({
                baseUrl: provider.baseUrl,
                model: modelId,
                messages,
                onDelta: (delta: string) => {
                  void this.panel.webview.postMessage({ type: 'stream.delta', messageId, delta });
                },
              });
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : String(err);
              await this.panel.webview.postMessage({ type: 'stream.error', messageId, error: errMsg });
              await this.sessionManager.finalizeStreamingMessage(messageId, `Error: ${errMsg}`);
              await this.refresh();
              return;
            }

            await this.sessionManager.finalizeStreamingMessage(messageId, accumulated);
            await this.panel.webview.postMessage({ type: 'stream.done', messageId });
            await this.refresh();
            return;
          }
        }
      },
      undefined,
      []
    );
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'chat.css'));

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Lopilot Chat</title>
  </head>
  <body>
    <div class="app-shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">Lopilot</p>
          <h1>Local-first chat scaffold</h1>
        </div>
        <div class="topbar__badges">
          <span class="badge">Workspace scoped</span>
          <span id="connection-indicator" class="badge badge--warning">Offline</span>
        </div>
      </header>

      <section class="layout">
        <aside class="sessions-pane">
          <div class="pane-heading">
            <div>
              <p class="eyebrow">Sessions</p>
              <h2>Recent conversations</h2>
            </div>
            <button id="new-session" class="button button--ghost" type="button">New</button>
          </div>
          <div id="session-list" class="session-list"></div>
        </aside>

        <main class="conversation-pane">
          <div id="conversation-meta" class="conversation-meta"></div>
          <div id="messages" class="messages"></div>

          <form id="composer" class="composer">
            <label class="composer__label" for="prompt-input">Prompt</label>
            <textarea
              id="prompt-input"
              class="composer__input"
              rows="4"
              placeholder="Ask about the current file, a selection, or the repo."
            ></textarea>
            <div class="composer__actions">
              <fieldset class="context-toggles" aria-label="Context included with chat prompts">
                <label class="context-toggle">
                  <input id="include-file" type="checkbox" checked />
                  <span>File</span>
                </label>
                <label class="context-toggle">
                  <input id="include-selection" type="checkbox" checked />
                  <span>Selection</span>
                </label>
                <label class="context-toggle">
                  <input id="include-repository" type="checkbox" checked />
                  <span>Repository</span>
                </label>
              </fieldset>
              <p id="composer-hint" class="composer__hint">Cmd/Ctrl+Enter sends the prompt.</p>
              <button class="button" type="submit">Send</button>
            </div>
          </form>
        </main>
      </section>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function normalizeChatContextOptions(options: Partial<ChatContextOptions> | undefined): ChatContextOptions {
  return {
    includeCurrentFile: options?.includeCurrentFile ?? DEFAULT_CHAT_CONTEXT_OPTIONS.includeCurrentFile,
    includeSelection: options?.includeSelection ?? DEFAULT_CHAT_CONTEXT_OPTIONS.includeSelection,
    includeRepositoryContext: options?.includeRepositoryContext ?? DEFAULT_CHAT_CONTEXT_OPTIONS.includeRepositoryContext
  };
}

function summarizeContextBundle(bundle: Awaited<ReturnType<SharedContextPipeline['build']>>): Record<string, number> {
  return bundle.items.reduce<Record<string, number>>((summary, item) => {
    summary[item.kind] = (summary[item.kind] ?? 0) + 1;
    return summary;
  }, {});
}

function formatProviderReadinessFailure(availability: import('../provider/ProviderManager').ProviderAvailability, detail: string): string {
  switch (availability) {
    case 'unavailable':
      return `The active Ollama provider is unavailable. ${detail}`;
    case 'no-models':
      return detail;
    case 'blocked':
      return `Provider requests are blocked. ${detail}`;
    case 'unsupported':
      return detail;
    case 'not-selected':
      return 'No active provider is selected. Use "Lopilot: Select Provider" first.';
    default:
      return detail;
  }
}

function toConnectionIndicator(lifecycleState: import('../provider/ProviderState').ProviderLifecycleState): { state: string; label: string } {
  switch (lifecycleState) {
    case 'local-configured':
      return { state: 'local', label: 'Local' };
    case 'remote-configured-blocked':
      return { state: 'remote-blocked', label: 'Remote blocked' };
    case 'remote-enabled':
      return { state: 'remote-enabled', label: 'Remote enabled' };
    case 'local-available':
    case 'no-provider':
    default:
      return { state: 'offline', label: 'Offline' };
  }
}

function getNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let index = 0; index < 32; index += 1) {
    nonce += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return nonce;
}