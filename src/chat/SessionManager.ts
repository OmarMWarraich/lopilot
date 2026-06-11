import * as vscode from 'vscode';

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatSessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatViewModel {
  activeSessionId: string | null;
  activeSession: ChatSession | null;
  sessions: ChatSessionSummary[];
}

export interface CreateSessionOptions {
  title?: string;
  initialUserMessage?: string;
}

interface PersistedSessionState {
  activeSessionId: string | null;
  sessions: ChatSession[];
}

const STORAGE_KEY = 'lopilot.chat.sessions.v1';
const UNTITLED_SESSION_TITLE = 'New session';

export class SessionManager {
  private state: PersistedSessionState;

  public constructor(private readonly storage: vscode.Memento) {
    this.state = storage.get<PersistedSessionState>(STORAGE_KEY) ?? {
      activeSessionId: null,
      sessions: []
    };
  }

  public async ensureSession(): Promise<ChatSession> {
    return this.getActiveSession() ?? this.createSession();
  }

  public getActiveSession(): ChatSession | null {
    if (!this.state.activeSessionId) {
      return null;
    }

    return this.state.sessions.find((session) => session.id === this.state.activeSessionId) ?? null;
  }

  public getViewModel(): ChatViewModel {
    const activeSession = this.getActiveSession();
    const sessions = [...this.state.sessions]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length
      }));

    return {
      activeSessionId: this.state.activeSessionId,
      activeSession,
      sessions
    };
  }

  public async createSession(options: CreateSessionOptions = {}): Promise<ChatSession> {
    const createdAt = timestamp();
    const initialMessage = options.initialUserMessage?.trim();
    const title = options.title?.trim() || deriveTitle(initialMessage);

    const session: ChatSession = {
      id: createId('session'),
      title,
      createdAt,
      updatedAt: createdAt,
      messages: initialMessage ? [createMessage('user', initialMessage, createdAt)] : []
    };

    this.state = {
      activeSessionId: session.id,
      sessions: [session, ...this.state.sessions]
    };

    await this.save();
    return session;
  }

  public async setActiveSession(sessionId: string): Promise<ChatSession | null> {
    const session = this.state.sessions.find((candidate) => candidate.id === sessionId) ?? null;

    if (!session) {
      return null;
    }

    this.state.activeSessionId = session.id;
    await this.save();
    return session;
  }

  public async appendUserMessage(content: string): Promise<ChatSession> {
    return this.appendMessage('user', content);
  }

  public async appendAssistantMessage(content: string): Promise<ChatSession> {
    return this.appendMessage('assistant', content);
  }

  private async appendMessage(role: ChatRole, content: string): Promise<ChatSession> {
    const trimmedContent = content.trim();
    const session = await this.ensureSession();

    if (!trimmedContent) {
      return session;
    }

    const updatedAt = timestamp();
    const activeSession = this.state.sessions.find((candidate) => candidate.id === session.id);

    if (!activeSession) {
      return session;
    }

    activeSession.messages.push(createMessage(role, trimmedContent, updatedAt));
    activeSession.updatedAt = updatedAt;

    if (activeSession.title === UNTITLED_SESSION_TITLE && role === 'user') {
      activeSession.title = deriveTitle(trimmedContent);
    }

    this.state.activeSessionId = activeSession.id;
    await this.save();
    return activeSession;
  }

  private async save(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this.state);
  }
}

function createMessage(role: ChatRole, content: string, createdAt = timestamp()): ChatMessage {
  return {
    id: createId('message'),
    role,
    content,
    createdAt
  };
}

function deriveTitle(initialUserMessage?: string): string {
  if (!initialUserMessage) {
    return UNTITLED_SESSION_TITLE;
  }

  const firstMeaningfulLine = initialUserMessage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstMeaningfulLine) {
    return UNTITLED_SESSION_TITLE;
  }

  return truncate(firstMeaningfulLine, 48);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}