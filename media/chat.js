(function () {
  const vscode = acquireVsCodeApi();

  const sessionList = document.getElementById('session-list');
  const conversationMeta = document.getElementById('conversation-meta');
  const messagesContainer = document.getElementById('messages');
  const composer = document.getElementById('composer');
  const promptInput = document.getElementById('prompt-input');
  const composerHint = document.getElementById('composer-hint');
  const sendButton = composer.querySelector('button[type="submit"]');
  const newSessionButton = document.getElementById('new-session');
  const connectionIndicator = document.getElementById('connection-indicator');
  const includeFileInput = document.getElementById('include-file');
  const includeSelectionInput = document.getElementById('include-selection');
  const includeRepositoryInput = document.getElementById('include-repository');

  // Migrate old state shapes: pre-provider builds stored sessions at the top level
  // without a `chat` key. Reset to defaults if the shape is unrecognised.
  const _persisted = vscode.getState();
  const _isLegacyShape = _persisted && !_persisted.chat;
  let state = (!_persisted || _isLegacyShape) ? {
    chat: {
      activeSessionId: null,
      activeSession: null,
      sessions: []
    },
    provider: {
      state: 'no-provider',
      stateDescription: 'No provider configured',
      canSendRequest: false,
      activeProvider: null,
      indicator: { state: 'offline', label: 'Offline' }
    },
    contextOptions: {
      includeCurrentFile: true,
      includeSelection: true,
      includeRepositoryContext: true
    }
  } : _persisted;

  state.contextOptions = normalizeContextOptions(state.contextOptions);
  hydrateContextToggles();

  newSessionButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();

    const prompt = promptInput.value.trim();
    if (!prompt) {
      return;
    }

    const contextOptions = readContextOptions();
    state.contextOptions = contextOptions;
    vscode.setState(state);

    vscode.postMessage({ type: 'sendPrompt', prompt, contextOptions });
    promptInput.value = '';
    promptInput.focus();
  });

  [includeFileInput, includeSelectionInput, includeRepositoryInput].forEach((input) => {
    input.addEventListener('change', () => {
      state.contextOptions = readContextOptions();
      vscode.setState(state);
    });
  });

  promptInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      composer.requestSubmit();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message && message.type === 'state') {
      const contextOptions = normalizeContextOptions(state.contextOptions);
      state = {
        ...message.payload,
        contextOptions
      };
      vscode.setState(state);
      hydrateContextToggles();
      render();
    }

    if (message && message.type === 'stream.start') {
      const existing = messagesContainer.querySelector(`[data-message-id="${message.messageId}"]`);
      if (existing) {
        existing.remove();
      }

      // Append an empty streaming assistant bubble
      const bubble = document.createElement('article');
      bubble.className = 'message message--assistant message--streaming';
      bubble.dataset.messageId = message.messageId;

      const meta = document.createElement('span');
      meta.className = 'message__meta';
      meta.textContent = 'assistant | now';

      const body = document.createElement('div');
      body.className = 'message__body';

      const context = document.createElement('span');
      context.className = 'message__context';
      context.textContent = formatContextSummary(message.contextSummary);

      bubble.append(meta, context, body);
      messagesContainer.append(bubble);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    if (message && message.type === 'stream.delta') {
      const bubble = messagesContainer.querySelector(`[data-message-id="${message.messageId}"]`);
      if (bubble) {
        const body = bubble.querySelector('.message__body');
        if (body) {
          body.textContent = (body.textContent ?? '') + message.delta;
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
      }
    }

    if (message && message.type === 'stream.error') {
      const bubble = messagesContainer.querySelector(`[data-message-id="${message.messageId}"]`);
      if (bubble) {
        bubble.classList.remove('message--streaming');
        bubble.classList.add('message--error');
        const body = bubble.querySelector('.message__body');
        if (body) {
          body.textContent = `Error: ${message.error}`;
        }
      }
    }

    if (message && message.type === 'stream.done') {
      const bubble = messagesContainer.querySelector(`[data-message-id="${message.messageId}"]`);
      if (bubble) {
        bubble.classList.remove('message--streaming');
      }
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });

  function render() {
    renderConnectionIndicator();
    renderSessions();
    renderConversationMeta();
    renderMessages();
    renderComposerState();
  }

  function renderConnectionIndicator() {
    const indicator = getProviderIndicator(state.provider);
    connectionIndicator.textContent = indicator.label;
    connectionIndicator.className = `badge badge--${getConnectionBadgeClass(indicator.state)}`;
  }

  function renderSessions() {
    sessionList.replaceChildren();

    if (!state.chat.sessions.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No sessions yet. Start a new prompt to create one.';
      sessionList.append(empty);
      return;
    }

    state.chat.sessions.forEach((session) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'session-card';
      if (session.id === state.chat.activeSessionId) {
        card.classList.add('is-active');
      }

      const title = document.createElement('p');
      title.className = 'session-card__title';
      title.textContent = session.title;

      const meta = document.createElement('p');
      meta.className = 'session-card__meta';
      meta.textContent = `${formatTimestamp(session.updatedAt)} | ${session.messageCount} message${
        session.messageCount === 1 ? '' : 's'
      }`;

      card.append(title, meta);
      card.addEventListener('click', () => {
        vscode.postMessage({ type: 'selectSession', sessionId: session.id });
      });

      sessionList.append(card);
    });
  }

  function renderConversationMeta() {
    conversationMeta.replaceChildren();

    if (!state.chat.activeSession) {
      conversationMeta.textContent = 'Create or select a session to begin.';
      return;
    }

    const title = document.createElement('strong');
    title.textContent = state.chat.activeSession.title;

    const meta = document.createElement('span');
    meta.className = 'composer__hint';
    meta.textContent = `Updated ${formatTimestamp(state.chat.activeSession.updatedAt)}`;

    const providerBadge = document.createElement('span');
    providerBadge.className = `badge badge--${getProviderBadgeClass(state.provider.state)}`;
    providerBadge.textContent = state.provider.stateDescription;

    const contextBadge = document.createElement('span');
    contextBadge.className = 'badge';
    contextBadge.textContent = formatEnabledContext(state.contextOptions);

    conversationMeta.append(title, meta, contextBadge, providerBadge);
  }

  function renderComposerState() {
    const blocked = !state.provider.canSendRequest;
    promptInput.disabled = blocked;
    sendButton.disabled = blocked;

    if (!blocked) {
      composerHint.textContent = 'Cmd/Ctrl+Enter sends the prompt.';
      return;
    }

    const indicator = getProviderIndicator(state.provider);
    switch (indicator.state) {
      case 'remote-blocked':
        composerHint.textContent = 'Remote usage is blocked until you run Lopilot: Enable Remote Providers.';
        break;
      case 'offline':
      default:
        composerHint.textContent = 'Offline. Configure a local backend or select a local provider to send prompts.';
        break;
    }
  }

  function renderMessages() {
    messagesContainer.replaceChildren();

    if (!state.chat.activeSession || !state.chat.activeSession.messages.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'This session is ready. Ask a question to exercise the chat plumbing.';
      messagesContainer.append(empty);
      return;
    }

    state.chat.activeSession.messages.forEach((message) => {
      const bubble = document.createElement('article');
      bubble.className = `message message--${message.role}`;

      const meta = document.createElement('span');
      meta.className = 'message__meta';
      meta.textContent = `${message.role} | ${formatTimestamp(message.createdAt)}`;

      const body = document.createElement('div');
      body.className = 'message__body';
      body.textContent = message.content;

      bubble.append(meta, body);
      messagesContainer.append(bubble);
    });

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    }).format(date);
  }

  function getProviderBadgeClass(providerState) {
    switch (providerState) {
      case 'local-configured':
      case 'remote-enabled':
        return 'success';
      case 'local-available':
      case 'remote-configured-blocked':
        return 'warning';
      default:
        return 'error';
    }
  }

  function getConnectionBadgeClass(indicatorState) {
    switch (indicatorState) {
      case 'local':
        return 'success';
      case 'remote-enabled':
        return 'accent';
      case 'remote-blocked':
        return 'warning';
      default:
        return 'error';
    }
  }

  function getProviderIndicator(provider) {
    if (provider?.indicator) {
      return provider.indicator;
    }

    switch (provider?.state) {
      case 'local-configured':
        return { state: 'local', label: 'Local' };
      case 'remote-enabled':
        return { state: 'remote-enabled', label: 'Remote' };
      case 'remote-configured-blocked':
        return { state: 'remote-blocked', label: 'Remote Blocked' };
      default:
        return { state: 'offline', label: 'Offline' };
    }
  }

  function readContextOptions() {
    return {
      includeCurrentFile: includeFileInput.checked,
      includeSelection: includeSelectionInput.checked,
      includeRepositoryContext: includeRepositoryInput.checked
    };
  }

  function hydrateContextToggles() {
    includeFileInput.checked = state.contextOptions.includeCurrentFile;
    includeSelectionInput.checked = state.contextOptions.includeSelection;
    includeRepositoryInput.checked = state.contextOptions.includeRepositoryContext;
  }

  function normalizeContextOptions(options) {
    return {
      includeCurrentFile: options?.includeCurrentFile ?? true,
      includeSelection: options?.includeSelection ?? true,
      includeRepositoryContext: options?.includeRepositoryContext ?? true
    };
  }

  function formatEnabledContext(options) {
    const enabled = [];
    if (options.includeCurrentFile) {
      enabled.push('file');
    }
    if (options.includeSelection) {
      enabled.push('selection');
    }
    if (options.includeRepositoryContext) {
      enabled.push('repository');
    }

    return enabled.length ? `Context: ${enabled.join(', ')}` : 'Context: none';
  }

  function formatContextSummary(summary) {
    if (!summary || Object.keys(summary).length === 0) {
      return 'No context attached';
    }

    const labels = {
      'current-file': 'file',
      selection: 'selection',
      'neighbor-file': 'neighbor',
      'repository-signal': 'repository',
      'conversation-state': 'conversation'
    };

    return Object.entries(summary)
      .map(([kind, count]) => `${labels[kind] ?? kind}: ${count}`)
      .join(' | ');
  }
})();