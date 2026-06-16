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

interface InlineCandidateSession {
  id: number;
  documentUri: string;
  documentVersion: number;
  range: vscode.Range;
  position: vscode.Position;
  candidates: string[];
  activeIndex: number;
}

interface InlineCompletionMessageOptions {
  candidateIndex?: number;
  totalCandidates?: number;
  strategy?: string;
}

const DEFAULT_MAX_PREFIX_CHARS = 5000;
const DEFAULT_MAX_SUFFIX_CHARS = 2000;
const MAX_INLINE_COMPLETION_CHARS = 1600;
const MAX_INLINE_CANDIDATES = 3;
const PARTIAL_PREVIEW_THROTTLE_MS = 40;
const INLINE_DIFF_PREVIEW_SCHEME = 'lopilot-inline-preview';
const DOCUMENT_SELECTOR: vscode.DocumentSelector = [
  { scheme: 'file' },
  { scheme: 'untitled' }
];

const CANDIDATE_STRATEGIES = [
  'Prefer the most likely concise continuation.',
  'Offer a slightly more explicit alternative without adding unrelated code.',
  'Offer a compact alternative that preserves the surrounding style.'
];

export class LopilotInlineCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  private readonly contextPipeline = new SharedContextPipeline();
  private readonly diffPreviewContentProvider = new InlineDiffPreviewContentProvider();
  private readonly previewDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('editorGhostText.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 2px'
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed
  });
  private activeRun: ActiveInlineRun | null = null;
  private candidateSession: InlineCandidateSession | null = null;
  private runSequence = 0;
  private candidateSessionSequence = 0;
  private lastPreviewUpdate = 0;

  public constructor(private readonly providerManager: ProviderManager) {}

  public static register(context: vscode.ExtensionContext, providerManager: ProviderManager): LopilotInlineCompletionProvider {
    const provider = new LopilotInlineCompletionProvider(providerManager);
    context.subscriptions.push(
      provider,
      vscode.languages.registerInlineCompletionItemProvider(DOCUMENT_SELECTOR, provider),
      vscode.commands.registerCommand('lopilot.cancelInlineCompletion', () => provider.dismissCompletionCandidates()),
      vscode.commands.registerCommand('lopilot.acceptCompletionCandidate', () => provider.acceptActiveCandidate()),
      vscode.commands.registerCommand('lopilot.cycleCompletionCandidate', () => provider.cycleCompletionCandidate()),
      vscode.commands.registerCommand('lopilot.dismissCompletionCandidates', () => provider.dismissCompletionCandidates()),
      vscode.commands.registerCommand('lopilot.acceptNextInlineEdit', () => provider.acceptNextInlineEdit()),
      vscode.commands.registerCommand('lopilot.previewInlineDiff', () => provider.previewActiveCandidateDiff()),
      vscode.commands.registerCommand('lopilot.recordInlineCompletionAccepted', (sessionId: number) => provider.recordInlineCompletionAccepted(sessionId))
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
      const messages = buildInlineCompletionMessages(promptContext, {
        candidateIndex: 1,
        totalCandidates: MAX_INLINE_CANDIDATES,
        strategy: CANDIDATE_STRATEGIES[0]
      });

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

      const candidates = await this.buildCompletionCandidates(provider.baseUrl, modelId, promptContext, insertText, abortController.signal);
      if (token.isCancellationRequested || this.activeRun?.id !== run.id || candidates.length === 0) {
        return undefined;
      }

      const session = this.createCandidateSession(document, requestRange, position, candidates);
      return new vscode.InlineCompletionList(candidates.map((candidate, index) => this.createInlineCompletionItem(candidate, requestRange, session.id, index)));
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

  public async acceptActiveCandidate(): Promise<void> {
    const session = this.getCurrentCandidateSession();
    if (!session) {
      return;
    }

    await this.applyCandidateText(session, session.candidates[session.activeIndex], true);
  }

  public cycleCompletionCandidate(): void {
    const session = this.getCurrentCandidateSession();
    if (!session || session.candidates.length < 2) {
      return;
    }

    session.activeIndex = (session.activeIndex + 1) % session.candidates.length;
    this.renderCandidatePreview(session);
  }

  public dismissCompletionCandidates(): void {
    this.cancelActiveCompletion();
    this.candidateSession = null;
    this.clearPartialPreview();
  }

  public async acceptNextInlineEdit(): Promise<void> {
    const session = this.getCurrentCandidateSession();
    if (!session) {
      return;
    }

    const activeCandidate = session.candidates[session.activeIndex];
    const nextEdit = getNextInlineEdit(activeCandidate);
    if (!nextEdit) {
      return;
    }

    const applied = await this.applyCandidateText(session, nextEdit.text, false);
    if (!applied) {
      return;
    }
    const remaining = activeCandidate.slice(nextEdit.text.length).replace(/^\r?\n/, '');
    if (!remaining.trim()) {
      this.dismissCompletionCandidates();
      return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.dismissCompletionCandidates();
      return;
    }

    const position = editor.selection.active;
    session.documentVersion = editor.document.version;
    session.position = position;
    session.range = new vscode.Range(position, position);
    session.candidates[session.activeIndex] = remaining;
    this.renderCandidatePreview(session);
  }

  public async previewActiveCandidateDiff(): Promise<void> {
    const session = this.getCurrentCandidateSession();
    const editor = vscode.window.activeTextEditor;
    if (!session || !editor) {
      void vscode.window.showInformationMessage('No active Lopilot inline candidate to preview.');
      return;
    }

    const candidate = session.candidates[session.activeIndex];
    const previewText = applyInlineCandidateToText(editor.document, session.range, candidate);
    const previewUri = this.diffPreviewContentProvider.setPreview({
      sourceUri: editor.document.uri,
      sessionId: session.id,
      candidateIndex: session.activeIndex,
      text: previewText
    });
    const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
    const title = `Lopilot Inline Preview: ${relativePath}`;

    await vscode.commands.executeCommand('vscode.diff', editor.document.uri, previewUri, title, {
      preview: false,
      viewColumn: vscode.ViewColumn.Beside
    });
  }

  public recordInlineCompletionAccepted(sessionId: number): void {
    if (this.candidateSession?.id === sessionId) {
      this.candidateSession = null;
      this.clearPartialPreview();
    }
  }

  public dispose(): void {
    this.cancelActiveCompletion();
    this.previewDecoration.dispose();
    this.diffPreviewContentProvider.dispose();
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

  private async buildCompletionCandidates(
    baseUrl: string,
    modelId: string,
    context: InlineCompletionPromptContext,
    primaryCandidate: string,
    signal: AbortSignal
  ): Promise<string[]> {
    const candidates = [primaryCandidate];

    for (let index = 1; index < MAX_INLINE_CANDIDATES; index += 1) {
      if (signal.aborted) {
        break;
      }

      const completion = await streamOllamaChat({
        baseUrl,
        model: modelId,
        messages: buildInlineCompletionMessages(context, {
          candidateIndex: index + 1,
          totalCandidates: MAX_INLINE_CANDIDATES,
          strategy: CANDIDATE_STRATEGIES[index]
        }),
        signal,
        onDelta: () => undefined
      });
      const candidate = sanitizeInlineCompletion(completion);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    return dedupeInlineCandidates(candidates);
  }

  private createCandidateSession(
    document: vscode.TextDocument,
    range: vscode.Range,
    position: vscode.Position,
    candidates: string[]
  ): InlineCandidateSession {
    const session = {
      id: this.candidateSessionSequence += 1,
      documentUri: document.uri.toString(),
      documentVersion: document.version,
      range,
      position,
      candidates,
      activeIndex: 0
    };
    this.candidateSession = session;
    return session;
  }

  private createInlineCompletionItem(candidate: string, range: vscode.Range, sessionId: number, candidateIndex: number): vscode.InlineCompletionItem {
    const item = new vscode.InlineCompletionItem(candidate, range, {
      command: 'lopilot.recordInlineCompletionAccepted',
      title: 'Record Accepted Lopilot Inline Completion',
      arguments: [sessionId, candidateIndex]
    });
    item.filterText = candidate;
    return item;
  }

  private getCurrentCandidateSession(): InlineCandidateSession | undefined {
    const session = this.candidateSession;
    const editor = vscode.window.activeTextEditor;
    if (!session || !editor || editor.document.uri.toString() !== session.documentUri || editor.document.version !== session.documentVersion) {
      return undefined;
    }

    return session;
  }

  private renderCandidatePreview(session: InlineCandidateSession): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== session.documentUri || editor.document.version !== session.documentVersion) {
      this.clearPartialPreview();
      return;
    }

    const candidate = session.candidates[session.activeIndex];
    const label = session.candidates.length > 1 ? ` (${session.activeIndex + 1}/${session.candidates.length})` : '';
    editor.setDecorations(this.previewDecoration, [
      {
        range: new vscode.Range(session.position, session.position),
        renderOptions: {
          after: {
            contentText: `${getStablePreviewLine(candidate)}${label}`
          }
        }
      }
    ]);
  }

  private async applyCandidateText(session: InlineCandidateSession, text: string, clearSession: boolean): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== session.documentUri || editor.document.version !== session.documentVersion) {
      this.dismissCompletionCandidates();
      return false;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(editor.document.uri, session.range, text);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      return false;
    }

    const nextPosition = editor.document.positionAt(editor.document.offsetAt(session.range.start) + text.length);
    editor.selection = new vscode.Selection(nextPosition, nextPosition);
    this.clearPartialPreview();

    if (clearSession) {
      this.candidateSession = null;
    }

    return true;
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

export function buildInlineCompletionMessages(
  context: InlineCompletionPromptContext,
  options: InlineCompletionMessageOptions = {}
): OllamaChatMessage[] {
  const candidateGuidance = options.candidateIndex && options.totalCandidates
    ? `Generate candidate ${options.candidateIndex} of ${options.totalCandidates}. ${options.strategy ?? ''}`.trim()
    : 'Generate the single best candidate.';

  return [
    {
      role: 'system',
      content: [
        'You are Lopilot, a local-first inline code completion engine inside VS Code.',
        'Return only the code text that should be inserted at <cursor>.',
        'Do not wrap the answer in Markdown. Do not explain. Do not repeat existing prefix text.',
        'Keep the suggestion short and syntactically compatible with the surrounding file.',
        candidateGuidance
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

export interface NextInlineEdit {
  text: string;
}

export function dedupeInlineCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const candidate of candidates) {
    const normalized = candidate.replace(/\s+/g, ' ').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    deduped.push(candidate);
  }

  return deduped.slice(0, MAX_INLINE_CANDIDATES);
}

export function getNextInlineEdit(candidate: string): NextInlineEdit | undefined {
  if (!candidate) {
    return undefined;
  }

  const newlineMatch = candidate.match(/^.*\r?\n/);
  if (newlineMatch?.[0] !== undefined) {
    return { text: newlineMatch[0] };
  }

  const wordMatch = candidate.match(/^\s*\S+\s*/);
  if (!wordMatch) {
    return undefined;
  }

  return { text: wordMatch[0] };
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

export function applyInlineCandidateToText(
  document: Pick<vscode.TextDocument, 'getText' | 'offsetAt'>,
  range: vscode.Range,
  candidate: string
): string {
  const text = document.getText();
  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);

  return `${text.slice(0, startOffset)}${candidate}${text.slice(endOffset)}`;
}

interface InlineDiffPreviewContent {
  sourceUri: vscode.Uri;
  sessionId: number;
  candidateIndex: number;
  text: string;
}

class InlineDiffPreviewContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly didChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly previews = new Map<string, string>();
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(INLINE_DIFF_PREVIEW_SCHEME, this);

  public readonly onDidChange = this.didChangeEmitter.event;

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.previews.get(uri.toString()) ?? '';
  }

  public setPreview(content: InlineDiffPreviewContent): vscode.Uri {
    const sourcePath = content.sourceUri.path || 'untitled';
    const previewUri = vscode.Uri.from({
      scheme: INLINE_DIFF_PREVIEW_SCHEME,
      path: sourcePath,
      query: new URLSearchParams({
        session: String(content.sessionId),
        candidate: String(content.candidateIndex + 1)
      }).toString()
    });

    const key = previewUri.toString();
    this.previews.set(key, content.text);
    if (this.previews.size > 50) {
      const oldestKey = this.previews.keys().next().value as string;
      this.previews.delete(oldestKey);
    }
    this.didChangeEmitter.fire(previewUri);
    return previewUri;
  }

  public dispose(): void {
    this.previews.clear();
    this.didChangeEmitter.dispose();
    this.registration.dispose();
  }
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
