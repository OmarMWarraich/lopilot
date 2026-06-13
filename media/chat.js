(function () {
  const vscode = acquireVsCodeApi();

  const sessionList = document.getElementById('session-list');
  const conversationMeta = document.getElementById('conversation-meta');
  const messagesContainer = document.getElementById('messages');
  const composer = document.getElementById('composer');
  const promptInput = document.getElementById('prompt-input');
  const newSessionButton = document.getElementById('new-session');

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
      activeProvider: null
    }
  } : _persisted;

  newSessionButton.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
  });

  composer.addEventListener('submit', (event) => {
    event.preventDefault();

    const prompt = promptInput.value.trim();
    if (!prompt) {
      return;
    }

    vscode.postMessage({ type: 'sendPrompt', prompt });
    promptInput.value = '';
    promptInput.focus();
  });

  promptInput.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      composer.requestSubmit();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;

    if (message && message.type === 'state') {
      state = message.payload;
      vscode.setState(state);
      render();
    }
  });

  render();
  vscode.postMessage({ type: 'ready' });

  function render() {
    renderSessions();
    renderConversationMeta();
    renderMessages();
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

    conversationMeta.append(title, meta, providerBadge);
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
})();