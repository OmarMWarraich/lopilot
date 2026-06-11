import * as vscode from 'vscode';

import { SessionManager } from './SessionManager';

type WebviewMessage =
  | { type: 'ready' }
  | { type: 'newSession' }
  | { type: 'selectSession'; sessionId: string }
  | { type: 'sendPrompt'; prompt: string };

export class LopilotPanel {
  private static currentPanel: LopilotPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private isReady = false;

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly sessionManager: SessionManager
  ) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.registerListeners();
  }

  public static render(extensionUri: vscode.Uri, sessionManager: SessionManager): LopilotPanel {
    if (LopilotPanel.currentPanel) {
      LopilotPanel.currentPanel.panel.reveal(vscode.ViewColumn.Beside);
      return LopilotPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel('lopilot.chat', 'Lopilot Chat', vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    });

    LopilotPanel.currentPanel = new LopilotPanel(panel, extensionUri, sessionManager);
    return LopilotPanel.currentPanel;
  }

  public async refresh(): Promise<void> {
    if (!this.isReady) {
      return;
    }

    await this.panel.webview.postMessage({
      type: 'state',
      payload: this.sessionManager.getViewModel()
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

            if (!prompt) {
              return;
            }

            await this.sessionManager.appendUserMessage(prompt);
            await this.sessionManager.appendAssistantMessage(
              'The chat scaffold is wired, but no model adapter is connected yet. Next steps are provider selection, streaming responses, and repo-aware retrieval.'
            );
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
          <span class="badge badge--accent">Local only</span>
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
              <p class="composer__hint">Cmd/Ctrl+Enter sends the prompt.</p>
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

function getNonce(): string {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';

  for (let index = 0; index < 32; index += 1) {
    nonce += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return nonce;
}