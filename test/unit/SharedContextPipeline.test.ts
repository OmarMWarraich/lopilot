import { describe, expect, it, vi } from 'vitest';

const vscodeState = vi.hoisted(() => ({
  activeTextEditor: undefined as unknown
}));

vi.mock('vscode', () => ({
  window: {
    get activeTextEditor() {
      return vscodeState.activeTextEditor;
    }
  },
  workspace: {
    workspaceFolders: [{ name: 'workspace', uri: { fsPath: '/workspace', toString: () => 'file:///workspace' } }],
    asRelativePath: () => 'src/example.ts',
    getWorkspaceFolder: () => ({ name: 'workspace', uri: { fsPath: '/workspace', toString: () => 'file:///workspace' } }),
    findFiles: vi.fn(async () => []),
    fs: {
      readFile: vi.fn(async () => {
        throw new Error('not found');
      })
    }
  },
  RelativePattern: class RelativePattern {
    public constructor(public readonly base: unknown, public readonly pattern: string) {}
  }
}));

import { SharedContextPipeline } from '../../src/context';

describe('SharedContextPipeline chat context toggles', () => {
  it('omits file, selection, repository, and conversation context when disabled', async () => {
    vscodeState.activeTextEditor = createEditorDouble({ selectedText: 'const selected = true;' });

    const bundle = await new SharedContextPipeline().build({
      conversation: [{ role: 'user', content: 'previous question' }],
      includeCurrentFile: false,
      includeSelection: false,
      includeRepositoryContext: false,
      includeConversationState: false
    });

    expect(bundle.items).toEqual([]);
  });

  it('includes current file and selection independently from repository context', async () => {
    vscodeState.activeTextEditor = createEditorDouble({ selectedText: 'const selected = true;' });

    const bundle = await new SharedContextPipeline().build({
      includeCurrentFile: true,
      includeSelection: true,
      includeRepositoryContext: false,
      includeConversationState: false
    });

    expect(bundle.items.map((item) => item.kind)).toEqual(['current-file', 'selection']);
    expect(bundle.items[1].content).toBe('const selected = true;');
  });
});

function createEditorDouble(options: { selectedText: string }) {
  const fullText = ['const value = 1;', options.selectedText, 'console.log(value);'].join('\n');
  const selection = {
    isEmpty: false,
    start: { line: 1, character: 0 },
    end: { line: 1, character: options.selectedText.length }
  };

  return {
    selection,
    document: {
      uri: { scheme: 'file', fsPath: '/workspace/src/example.ts', toString: () => 'file:///workspace/src/example.ts' },
      languageId: 'typescript',
      lineCount: 3,
      isDirty: false,
      getText: (range?: unknown) => range ? options.selectedText : fullText
    }
  };
}
