import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: {
    asRelativePath: () => 'src/example.ts'
  },
  window: {
    createTextEditorDecorationType: () => ({ dispose: () => undefined }),
    visibleTextEditors: []
  },
  languages: {
    registerInlineCompletionItemProvider: () => ({ dispose: () => undefined })
  },
  commands: {
    registerCommand: () => ({ dispose: () => undefined })
  },
  ThemeColor: class ThemeColor {
    public constructor(public readonly id: string) {}
  },
  Range: class Range {
    public constructor(public readonly start: unknown, public readonly end: unknown) {}
  },
  InlineCompletionItem: class InlineCompletionItem {
    public filterText?: string;
    public constructor(public readonly insertText: string, public readonly range: unknown) {}
  },
  InlineCompletionList: class InlineCompletionList {
    public constructor(public readonly items: unknown[]) {}
  },
  DecorationRangeBehavior: {
    ClosedClosed: 1
  }
}));

import {
  buildInlineCompletionMessages,
  buildInlineCompletionPromptContext,
  getStablePreviewLine,
  sanitizeInlineCompletion
} from '../../src/inline';

describe('InlineCompletionProvider prompt helpers', () => {
  it('builds bounded prefix and suffix context around the cursor', () => {
    const text = 'const alpha = 1;\nconst beta = alp';
    const position = { line: 1, character: 'const beta = alp'.length };
    const document = createDocumentDouble(text, 'typescript');

    const context = buildInlineCompletionPromptContext(document as never, position as never, 'shared context', {
      maxPrefixChars: 12,
      maxSuffixChars: 8
    });

    expect(context.prefix).toBe('t beta = alp');
    expect(context.suffix).toBe('');
    expect(context.linePrefix).toBe('t beta = alp');
    expect(context.languageId).toBe('typescript');
  });

  it('constructs strict insertion-only model messages', () => {
    const messages = buildInlineCompletionMessages({
      languageId: 'typescript',
      relativePath: 'src/example.ts',
      prefix: 'const value = ',
      suffix: ';\n',
      linePrefix: 'const value = ',
      sharedContext: 'workspace summary'
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('Return only the code text');
    expect(messages[1].content).toContain('<cursor></cursor>');
    expect(messages[1].content).toContain('src/example.ts');
  });

  it('sanitizes markdown fences, cursor tags, leading newlines, and oversized completions', () => {
    const longValue = 'x'.repeat(2000);
    const sanitized = sanitizeInlineCompletion('```ts\n<cursor>' + longValue + '</cursor>\n```');

    expect(sanitized.startsWith('x')).toBe(true);
    expect(sanitized).not.toContain('```');
    expect(sanitized).not.toContain('<cursor>');
    expect(sanitized.length).toBeLessThanOrEqual(1600);
  });

  it('keeps partial preview to a stable single editor line', () => {
    expect(getStablePreviewLine('first line\nsecond line')).toBe('first line');
    expect(getStablePreviewLine('x'.repeat(140))).toHaveLength(120);
  });
});

function createDocumentDouble(text: string, languageId: string) {
  return {
    languageId,
    uri: { scheme: 'file', toString: () => 'file:///workspace/src/example.ts' },
    getText: () => text,
    offsetAt: (position: { line: number; character: number }) => {
      const lines = text.split('\n');
      const preceding = lines.slice(0, position.line).join('\n');
      return preceding.length + (position.line > 0 ? 1 : 0) + position.character;
    }
  };
}
