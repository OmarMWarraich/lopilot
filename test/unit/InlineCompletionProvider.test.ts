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
  },
  EventEmitter: class EventEmitter {
    public readonly event = () => ({ dispose: () => undefined });
    public fire() {}
    public dispose() {}
  }
}));

import {
  applyInlineCandidateToText,
  buildInlineCompletionMessages,
  buildInlineCompletionPromptContext,
  dedupeInlineCandidates,
  getNextInlineEdit,
  getStablePreviewLine,
  sanitizeInlineCompletion
} from '../../src/inline';

describe('InlineCompletionProvider prompt helpers', () => {
  describe('prompt assembly', () => {
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

    it('extracts line prefix correctly after newline', () => {
      const text = 'function greet() {\n  console.';
      const position = { line: 1, character: '  console.'.length };
      const document = createDocumentDouble(text, 'javascript');

      const context = buildInlineCompletionPromptContext(document as never, position as never, '', {
        maxPrefixChars: 100,
        maxSuffixChars: 50
      });

      expect(context.linePrefix).toBe('  console.');
      expect(context.prefix).toContain('function greet()');
    });

    it('handles prefix truncation at max boundary', () => {
      const text = 'a'.repeat(10000) + 'cursor_here';
      const position = { line: 0, character: 10000 };  // Position at the end of 'a's
      const document = createDocumentDouble(text, 'python');

      const context = buildInlineCompletionPromptContext(document as never, position as never, '', {
        maxPrefixChars: 500
      });

      expect(context.prefix.length).toBe(500);
      expect(context.prefix).toBe('a'.repeat(500));
      expect(context.prefix).not.toContain('cursor_here');
    });

    it('handles suffix truncation at max boundary', () => {
      const text = 'cursor_here' + 'b'.repeat(10000);
      const position = { line: 0, character: 11 };
      const document = createDocumentDouble(text, 'java');

      const context = buildInlineCompletionPromptContext(document as never, position as never, '', {
        maxSuffixChars: 300
      });

      expect(context.suffix.length).toBe(300);
      expect(context.suffix).toBe('b'.repeat(300));
    });

    it('includes shared context in the prompt', () => {
      const context = buildInlineCompletionPromptContext(
        createDocumentDouble('x = ', 'python') as never,
        { line: 0, character: 4 } as never,
        'This is a math utils file with common helpers'
      );

      expect(context.sharedContext).toBe('This is a math utils file with common helpers');
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
      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('Return only the code text');
      expect(messages[0].content).toContain('Do not wrap the answer in Markdown');
      expect(messages[1].role).toBe('user');
      expect(messages[1].content).toContain('<cursor></cursor>');
      expect(messages[1].content).toContain('src/example.ts');
      expect(messages[1].content).toContain('<prefix>');
      expect(messages[1].content).toContain('<suffix>');
    });

    it('adds candidate-specific guidance for multiple inline options', () => {
      const context = {
        languageId: 'typescript',
        relativePath: 'src/example.ts',
        prefix: 'const value = ',
        suffix: ';\n',
        linePrefix: 'const value = ',
        sharedContext: 'workspace summary'
      };

      const messages1 = buildInlineCompletionMessages(context, {
        candidateIndex: 1,
        totalCandidates: 3,
        strategy: 'Prefer the most likely concise continuation.'
      });

      const messages2 = buildInlineCompletionMessages(context, {
        candidateIndex: 2,
        totalCandidates: 3,
        strategy: 'Offer a slightly more explicit alternative.'
      });

      expect(messages1[0].content).toContain('Generate candidate 1 of 3');
      expect(messages1[0].content).toContain('Prefer the most likely concise continuation.');
      expect(messages2[0].content).toContain('Generate candidate 2 of 3');
      expect(messages2[0].content).toContain('Offer a slightly more explicit alternative.');
    });

    it('uses fallback guidance when candidate options not fully specified', () => {
      const messages = buildInlineCompletionMessages({
        languageId: 'typescript',
        relativePath: 'src/example.ts',
        prefix: 'x = ',
        suffix: '',
        linePrefix: 'x = ',
        sharedContext: ''
      });

      expect(messages[0].content).toContain('Generate the single best candidate');
    });
  });

  describe('suggestion ranking and deduplication', () => {
    it('deduplicates completion candidates while preserving first-seen order', () => {
      expect(dedupeInlineCandidates(['alpha', 'alpha ', 'beta', '', 'gamma', 'delta'])).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('normalizes whitespace during deduplication comparison', () => {
      const candidates = ['foo  bar', 'foo bar', '  foo   bar  ', 'baz'];
      const deduped = dedupeInlineCandidates(candidates);
      // Returns the first-seen candidate with that normalized form
      expect(deduped).toEqual(['foo  bar', 'baz']);
      expect(deduped.length).toBe(2);
    });

    it('removes empty and whitespace-only candidates', () => {
      expect(dedupeInlineCandidates(['', '   ', 'real', '\n\t', 'actual'])).toEqual(['real', 'actual']);
    });

    it('respects MAX_INLINE_CANDIDATES limit after deduplication', () => {
      const candidates = ['a', 'b', 'c', 'd', 'e', 'f'];
      const deduped = dedupeInlineCandidates(candidates);
      expect(deduped.length).toBeLessThanOrEqual(3);
    });

    it('preserves order of first-seen candidates after deduplication', () => {
      const candidates = ['zebra', 'apple', 'apple  ', 'zebra ', 'banana'];
      const deduped = dedupeInlineCandidates(candidates);
      expect(deduped[0]).toBe('zebra');
      expect(deduped[1]).toBe('apple');
      expect(deduped[2]).toBe('banana');
    });

    it('handles candidates with line breaks and varied whitespace', () => {
      const candidates = [
        'line1\nline2',
        'line1\nline2',
        'line1  \nline2',
        'different'
      ];
      const deduped = dedupeInlineCandidates(candidates);
      expect(deduped.length).toBe(2);
    });
  });

  describe('completion acceptance behavior', () => {
    it('extracts next inline edit as line when multiline candidate provided', () => {
      const candidate = 'first line\nsecond line\nthird line';
      expect(getNextInlineEdit(candidate)?.text).toBe('first line\n');
    });

    it('extracts next inline edit as word when single-line candidate provided', () => {
      const candidate = 'value + 1';
      expect(getNextInlineEdit(candidate)?.text).toBe('value ');
    });

    it('handles windows-style line breaks in next edit extraction', () => {
      const candidate = 'first\r\nsecond';
      expect(getNextInlineEdit(candidate)?.text).toBe('first\r\n');
    });

    it('returns undefined for empty candidate', () => {
      expect(getNextInlineEdit('')).toBeUndefined();
      expect(getNextInlineEdit('   ')).toBeUndefined();
    });

    it('extracts leading whitespace and first token for next edit', () => {
      const candidate = '  functionName(';
      const edit = getNextInlineEdit(candidate);
      expect(edit?.text).toContain('function');
    });

    it('sanitizes markdown fences, cursor tags, leading newlines, and oversized completions', () => {
      const longValue = 'x'.repeat(2000);
      const sanitized = sanitizeInlineCompletion('```ts\n<cursor>' + longValue + '</cursor>\n```');

      expect(sanitized.startsWith('x')).toBe(true);
      expect(sanitized).not.toContain('```');
      expect(sanitized).not.toContain('<cursor>');
      expect(sanitized).not.toContain('</cursor>');
      expect(sanitized.length).toBeLessThanOrEqual(1600);
    });

    it('removes leading and trailing newlines from completions but preserves leading spaces', () => {
      const completion = '\n\n  value = 42\n';
      const sanitized = sanitizeInlineCompletion(completion);
      expect(sanitized.startsWith('\n')).toBe(false);
      // Leading spaces are preserved, only newlines are stripped from start
      expect(sanitized).toBe('  value = 42');
    });

    it('handles completion with only markdown fence', () => {
      const sanitized = sanitizeInlineCompletion('```');
      expect(sanitized).toBe('');
    });

    it('respects max completion character limit', () => {
      const longValue = 'a'.repeat(2000);
      const sanitized = sanitizeInlineCompletion(longValue);
      expect(sanitized.length).toBeLessThanOrEqual(1600);
    });

    it('keeps partial preview to a stable single editor line', () => {
      expect(getStablePreviewLine('first line\nsecond line')).toBe('first line');
      expect(getStablePreviewLine('x'.repeat(140))).toHaveLength(120);
    });

    it('handles windows line breaks in preview extraction', () => {
      expect(getStablePreviewLine('first\r\nsecond')).toBe('first');
    });

    it('truncates long preview lines to 120 characters', () => {
      const longLine = 'x'.repeat(150) + '\nshould not appear';
      expect(getStablePreviewLine(longLine)).toHaveLength(120);
    });

    it('applies an inline candidate to document text for diff previews', () => {
      const document = createDocumentDouble('const value = ;\nconsole.log(value);', 'typescript');
      const range = {
        start: { line: 0, character: 'const value = '.length },
        end: { line: 0, character: 'const value = '.length }
      };

      expect(applyInlineCandidateToText(document as never, range as never, '42')).toBe('const value = 42;\nconsole.log(value);');
    });

    it('replaces existing text at range when applying candidate', () => {
      const document = createDocumentDouble('const x = oldValue + 1;', 'typescript');
      const range = {
        start: { line: 0, character: 'const x = '.length },
        end: { line: 0, character: 'const x = oldValue'.length }
      };

      expect(applyInlineCandidateToText(document as never, range as never, 'newValue')).toBe('const x = newValue + 1;');
    });

    it('handles multiline document when applying candidate', () => {
      const document = createDocumentDouble('line1\nline2 here\nline3', 'python');
      const range = {
        start: { line: 1, character: 'line2 '.length },
        end: { line: 1, character: 'line2 here'.length }
      };

      expect(applyInlineCandidateToText(document as never, range as never, 'modified')).toBe('line1\nline2 modified\nline3');
    });

    it('inserts multiline candidate correctly', () => {
      const document = createDocumentDouble('const x = ;', 'javascript');
      const range = {
        start: { line: 0, character: 'const x = '.length },
        end: { line: 0, character: 'const x = '.length }
      };

      const multiline = '{\n  value: 42\n}';
      expect(applyInlineCandidateToText(document as never, range as never, multiline)).toBe('const x = {\n  value: 42\n};');
    });
  });

  describe('edge cases and robustness', () => {
    it('handles document with no newlines', () => {
      const text = 'single line code';
      const position = { line: 0, character: 7 };
      const document = createDocumentDouble(text, 'typescript');

      const context = buildInlineCompletionPromptContext(document as never, position as never, '');

      expect(context.linePrefix).toBe('single ');
      expect(context.prefix).toBe('single ');
    });

    it('handles cursor at document start', () => {
      const text = 'code here';
      const position = { line: 0, character: 0 };
      const document = createDocumentDouble(text, 'typescript');

      const context = buildInlineCompletionPromptContext(document as never, position as never, '', {
        maxPrefixChars: 100
      });

      expect(context.prefix).toBe('');
      expect(context.suffix).toContain('code here');
    });

    it('handles cursor at document end', () => {
      const text = 'code here';
      const position = { line: 0, character: text.length };
      const document = createDocumentDouble(text, 'typescript');

      const context = buildInlineCompletionPromptContext(document as never, position as never, '', {
        maxSuffixChars: 100
      });

      expect(context.prefix).toBe('code here');
      expect(context.suffix).toBe('');
    });

    it('handles empty document', () => {
      const document = createDocumentDouble('', 'typescript');
      const position = { line: 0, character: 0 };

      const context = buildInlineCompletionPromptContext(document as never, position as never, '');

      expect(context.prefix).toBe('');
      expect(context.suffix).toBe('');
    });

    it('removes only outermost fence markers', () => {
      const completion = '```\n```inner\ncode\n```\n```';
      const sanitized = sanitizeInlineCompletion(completion);
      // Removes leading ``` and trailing ```, leaving inner fences
      expect(sanitized).toContain('```inner');
      expect(sanitized).toContain('code');
    });

    it('deduplicates candidates with trailing whitespace using normalized comparison', () => {
      const candidates = ['  fn ', 'fn', 'fn   '];
      const deduped = dedupeInlineCandidates(candidates);
      // Returns the first-seen candidate with that normalized form, which is '  fn '
      expect(deduped.length).toBe(1);
      expect(deduped[0]).toBe('  fn ');
    });
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
