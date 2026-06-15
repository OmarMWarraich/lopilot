import * as vscode from 'vscode';

import { streamOllamaChat, OllamaChatMessage } from '../adapter/OllamaConnector';
import { SharedContextPipeline } from '../context';
import { ProviderManager } from '../provider/ProviderManager';

export interface InlineCompletionPromptContext {
  languageId: string;
  relativePath: string;
  prefix: string;
  suffix: string;
  linePrefix: string;
  sharedContext: string;
}

export interface InlineCompletionPromptOptions {
  maxPrefixChars?: number;
  maxSuffixChars?: number;
}

interface ActiveInlineRun {
  id: number;
  abortController: AbortController;
  disposable: vscode.Disposable;
  documentUri: string;
  documentVersion: number;
  position: vscode.Position;
}

const DEFAULT_MAX_PREFIX_CHARS = 5000;
const DEFAULT_MAX_SUFFIX_CHARS = 2000;
const MAX_INLINE_COMPLETION_CHARS = 1600;
const PARTIAL_PREVIEW_THROTTLE_MS = 40;
const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file' },
  { scheme: 'untitled' }
];

export class LopilotInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly contextPipeline = new SharedContextPipeline();
  private readonly previewDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 2px'
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private activeRun: ActiveInlineRun | null = null;
  private runSequence = 0;
  private lastPreviewUpdate = 0;

  public constructor(private readonly providerManager: ProviderManager) {}

  public static register(context: vscode.ExtensionContext, providerManager: ProviderManager): LopilotInlineCompletionProvider {
    const provider = new LopilotInlineCompletionProvider(providerManager);
    context.subscriptions.push(
      provider,
      vscode.languages.registerInlineCompletionItemProvider(DOCUMENT_SELECTOR, provider),
      vscode.commands.registerCommand('lopilot.cancelInlineCompletion', () => provider.cancelActiveCompletion())
    );
    return provider;
  }

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | undefined> {
    if (!this.shouldProvideCompletion(document, position)) {
      return undefined;
    }

    this.cancelActiveCompletion();

    const provider = this.providerManager.getActiveProvider();
    if (!provider || provider.type !== 'ollama' || !this.providerManager.canSendRequest()) {
      return undefined;
    }

    const models = await this.providerManager.listModels();
    if (token.isCancellationRequested || models.length === 0) {
      return undefined;
    }

    let modelId = this.providerManager.getActiveModelId();
    if (!modelId || !models.some((model) => model.id === modelId)) {
      modelId = models[0].id;
      await this.providerManager.setActiveModelId(modelId);
    }

    if (token.isCancellationRequested) {
      return undefined;
    }

    const requestRange = new vscode.Range(position, position);
    const abortController = new AbortController();
    const run: ActiveInlineRun = {
      id: this.runSequence += 1,
      abortController,
      disposable: token.onCancellationRequested(() => abortController.abort()),
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      position
    };
    this.activeRun = run;

    let accumulated = '';
    try {
      const contextBundle = await this.contextPipeline.build({
        maxCurrentFileChars: 4000,
        maxSelectionChars: 1200,
        maxNeighborFiles: 2,
        maxNeighborFileChars: 900,
        maxConversationTurns: 0
      });

      if (token.isCancellationRequested || this.activeRun?.id !== run.id) {
        return undefined;
      }

      const promptContext = buildInlineCompletionPromptContext(document, position, this.contextPipeline.formatSystemMessage(contextBundle));
      const messages = buildInlineCompletionMessages(promptContext);

      const completion = await streamOllamaChat({
        baseUrl: provider.baseUrl,
        model: modelId,
        messages,
        signal: abortController.signal,
        onDelta: (delta) => {
          accumulated += delta;
          this.updatePartialPreview(run, sanitizeInlineCompletion(accumulated));
        }
      });

      if (token.isCancellationRequested || this.activeRun?.id !== run.id) {
        return undefined;
      }

      const insertText = sanitizeInlineCompletion(completion);
      if (!insertText) {
        return undefined;
      }

      const item = new vscode.InlineCompletionItem(insertText, requestRange);
      item.filterText = insertText;
      return new vscode.InlineCompletionList([item]);
    } catch (error) {
      if (token.isCancellationRequested || abortController.signal.aborted || isAbortError(error)) {
        return undefined;
      }

      return undefined;
    } finally {
      if (this.activeRun?.id === run.id) {
        this.clearPartialPreview();
        this.activeRun = null;
      }
      run.disposable.dispose();
    }
  }

  public cancelActiveCompletion(): void {
    if (!this.activeRun) {
      return;
    }

    this.activeRun.abortController.abort();
    this.activeRun = null;
    this.clearPartialPreview();
  }

  public dispose(): void {
    this.cancelActiveCompletion();
    this.previewDecoration.dispose();
  }

  private shouldProvideCompletion(document: vscode.TextDocument, position: vscode.Position): boolean {
    if (document.isClosed || document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
      return false;
    }

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (linePrefix.trim().length === 0) {
      return false;
    }

    return !/[\s([{,;:]$/.test(linePrefix);
  }

  private updatePartialPreview(run: ActiveInlineRun, insertText: string): void {
    if (!insertText || this.activeRun?.id !== run.id) {
      return;
    }

    const now = Date.now();
    if (now - this.lastPreviewUpdate < PARTIAL_PREVIEW_THROTTLE_MS) {
      return;
    }
    this.lastPreviewUpdate = now;

    const editor = vscode.window.visibleTextEditors.find((candidate) => {
      return candidate.document.uri.toString() === run.documentUri && candidate.document.version === run.documentVersion;
    });

    if (!editor) {
      this.clearPartialPreview();
      return;
    }

    const firstLine = getStablePreviewLine(insertText);
    if (!firstLine) {
      return;
    }

    editor.setDecorations(this.previewDecoration, [
      {
        range: new vscode.Range(run.position, run.position),
        renderOptions: {
          after: {
            contentText: firstLine
          }
        }
      }
    ]);
  }

  private clearPartialPreview(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.previewDecoration, []);
    }
  }
}

export function buildInlineCompletionPromptContext(
  document: Pick<vscode.TextDocument, 'getText' | 'languageId' | 'uri' | 'offsetAt'>,
  position: vscode.Position,
  sharedContext: string,
  options: InlineCompletionPromptOptions = {}
): InlineCompletionPromptContext {
  const fullText = document.getText();
  const cursorOffset = document.offsetAt(position);
  const maxPrefixChars = options.maxPrefixChars ?? DEFAULT_MAX_PREFIX_CHARS;
  const maxSuffixChars = options.maxSuffixChars ?? DEFAULT_MAX_SUFFIX_CHARS;
  const prefix = fullText.slice(Math.max(0, cursorOffset - maxPrefixChars), cursorOffset);
  const suffix = fullText.slice(cursorOffset, cursorOffset + maxSuffixChars);
  const lineStart = prefix.lastIndexOf('\n') + 1;

  return {
    languageId: document.languageId,
    relativePath: vscode.workspace.asRelativePath(document.uri, false),
    prefix,
    suffix,
    linePrefix: prefix.slice(lineStart),
    sharedContext
  };
}

export function buildInlineCompletionMessages(context: InlineCompletionPromptContext): OllamaChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are Lopilot, a local-first inline code completion engine inside VS Code.',
        'Return only the code text that should be inserted at <cursor>.',
        'Do not wrap the answer in Markdown. Do not explain. Do not repeat existing prefix text.',
        'Keep the suggestion short and syntactically compatible with the surrounding file.'
      ].join('\n')
    },
    {
      role: 'user',
      content: [
        context.sharedContext,
        '',
        `File: ${context.relativePath}`,
        `Language: ${context.languageId}`,
        `Current line prefix: ${context.linePrefix}`,
        '',
        '<prefix>',
        context.prefix,
        '</prefix>',
        '<cursor></cursor>',
        '<suffix>',
        context.suffix,
        '</suffix>'
      ].join('\n')
    }
  ];
}

export function sanitizeInlineCompletion(value: string): string {
  const withoutFences = value
    .replace(/^```[\w-]*\s*/i, '')
    .replace(/\s*```$/i, '');
  const withoutCursorTags = withoutFences
    .replace(/<cursor><\/cursor>/gi, '')
    .replace(/<cursor>/gi, '')
    .replace(/<\/cursor>/gi, '');
  const trimmed = withoutCursorTags.replace(/^[\r\n]+/, '').slice(0, MAX_INLINE_COMPLETION_CHARS);

  return trimTrailingPartialFence(trimmed).trimEnd();
}

export function getStablePreviewLine(insertText: string): string {
  return insertText.split(/\r?\n/, 1)[0].slice(0, 120);
}

function trimTrailingPartialFence(value: string): string {
  const fenceIndex = value.lastIndexOf('```');
  if (fenceIndex <= 0) {
    return value;
  }

  return value.slice(0, fenceIndex);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('abort'));
}
