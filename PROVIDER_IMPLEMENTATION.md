# Local-First Provider Resolution Implementation

## Overview

This document describes the implementation of local-first provider resolution for the Lopilot extension. The system enforces explicit user opt-in before allowing remote requests while preferring discovered or configured local providers.

## Architecture

### Core Files

1. **ProviderState.ts** — Type definitions and state derivation logic
   - `ProviderLifecycleState`: enum-like type for all 5 provider states
   - `ProviderEndpoint`: metadata for discovered or configured providers
   - `ProviderConfig`: complete configuration snapshot
   - `deriveProviderLifecycleState()`: deterministic state calculation
   - `canSendRequest()`: authorization check for model requests
   - `getProviderStateDescription()`: human-readable state labels

2. **LocalDiscovery.ts** — Local provider discovery
   - `discoverLocalProviders()`: scans standard ports (Ollama: 11434, LocalAI: 8080/8000)
   - `testEndpoint()`: verifies provider health via health checks
   - Supports custom hosts and ports via `DiscoveryOptions`
   - Runs health checks in parallel for performance

3. **ProviderManager.ts** — Orchestration layer
   - Manages provider discovery, configuration, and state transitions
   - Persists state to VSCode workspace storage (key: `lopilot.provider.config.v1`)
   - Exposes async APIs for all provider operations
   - Enforces local-first preference and explicit remote consent

## Provider Lifecycle States

The implementation defines 5 explicit states that model all valid configurations:

### 1. **no-provider**

- No local providers discovered or configured
- No remote providers configured
- **Can send requests?** NO
- **Next actions:** Run "Discover Local Providers" or configure a remote provider

### 2. **local-available**

- Local providers discovered (e.g., Ollama on localhost:11434)
- OR local providers configured but none is active
- **Can send requests?** YES (will use first available local)
- **Next actions:** User selects a specific local provider to activate

### 3. **local-configured**

- A specific local provider is actively selected
- **Can send requests?** YES (to the active local provider)
- **Best state for privacy:** local code stays on user's machine
- **Next actions:** None required; ready to use

### 4. **remote-configured-blocked**

- Remote provider(s) are configured
- Remote requests have NOT been explicitly enabled
- **Can send requests?** NO (blocked by design)
- **Next actions:** User must run "Enable Remote Providers" to proceed
- **Privacy enforcement:** Prevents accidental code exfiltration

### 5. **remote-enabled**

- A remote provider is active
- User has explicitly opted into remote requests (after confirmation)
- **Can send requests?** YES (to the active remote provider)
- **UI indication:** Badge shows "remote enabled" to keep user aware

## State Transition Logic

The derivation logic in `deriveProviderLifecycleState()` follows these rules:

1. If an active provider is set:
   - If it's a local provider → **local-configured**
   - If it's a remote provider:
     - If remote requests allowed → **remote-enabled**
     - Else → **remote-configured-blocked**

2. If no active provider but local options exist → **local-available**

3. If no local options but remote configured:
   - If remote requests allowed → **remote-enabled**
   - Else → **remote-configured-blocked**

4. Otherwise → **no-provider**

## Extension Integration

### Commands Registered

1. **lopilot.discoverProviders** — Initiates local provider discovery
   - Scans standard ports and custom addresses
   - Shows notification with count of discovered providers
   - Updates configuration automatically

2. **lopilot.setActiveProvider** — Quick picker to select from available providers
   - Lists discovered local, configured local, and configured remote providers
   - Tests endpoint health before activation
   - Remote requests remain blocked until the user explicitly runs `lopilot.enableRemoteProviders`

3. **lopilot.enableRemoteProviders** — Explicit opt-in for remote requests
   - Shows warning: "Enabling remote providers will allow sending code to remote servers"
   - Requires user confirmation
   - Updates state and persists to storage

### Status Bar Integration

The status bar item now displays:

- **Text:** "$(comment-discussion) Lopilot"
- **Tooltip:** Full state description (e.g., "Using local provider"), refreshed after every state-changing operation (discovery, provider selection, remote enablement)

> **Note:** Color-coded badge indicators are planned as future work.

### Chat Panel Integration

The webview now receives and displays provider state:

```typescript
{
  chat: { activeSessionId, activeSession, sessions },
  provider: {
    state: ProviderLifecycleState,
    description: string,
    canSendRequest: boolean,
    activeProvider: ProviderEndpoint | null
  }
}
```

When user sends a prompt:

- If `canSendRequest` is false → assistant explains why (no provider, blocked remote, etc.)
- If `canSendRequest` is true → sends to the adapter (coming next)

## Provider Storage

Configuration is persisted to VSCode workspace storage under key: `lopilot.provider.config.v1`

Structure:

```typescript
{
  lifecycleState: ProviderLifecycleState,
  discoveredLocal: ProviderEndpoint[],      // Auto-found local providers
  configuredLocal: ProviderEndpoint[],       // User-registered local providers
  configuredRemote: ProviderEndpoint[],      // User-registered remote providers
  activeProviderId: string | null,           // Currently selected provider
  remoteRequestsAllowed: boolean,            // Explicit user consent for remote
  lastDiscoveryTime?: string                 // ISO timestamp of last discovery
}
```

## Local Discovery Details

### Supported Providers

| Provider    | Default Ports | Health Check                           |
| ----------- | ------------- | -------------------------------------- |
| **Ollama**  | 11434         | `/api/tags` → `/v1/models` → `/health` |
| **LocalAI** | 8080, 8000    | `/v1/models` → `/health`               |

### Discovery Algorithm

1. Iterate over hosts (localhost, 127.0.0.1, custom)
2. For each host + port combination:
   - Attempt health check with timeout (default 2s)
   - If successful, identify provider type via specific API endpoints
   - Record as `ProviderEndpoint` with `isDiscovered: true`
3. Return all discovered endpoints in parallel

### Custom Hosts and Ports

Users can extend discovery by configuring additional addresses:

```typescript
const discovered = await providerManager.discoverLocal({
  timeoutMs: 3000,
  customPorts: [9000, 9090],
  customHosts: ["192.168.1.10", "api.example.com"],
});
```

## Security Guarantees

1. **No accidental code exfiltration:**
   - Remote is blocked by default
   - Requires explicit confirmation with warning dialog

2. **Local-first preference:**
   - Discovered local providers are preferred automatically
   - Remote only used when explicitly selected and enabled

3. **Privacy indicator:**
   - Status bar badge changes to show current provider state
   - Users always know if remote requests are active

4. **Audit trail:**
   - Provider state changes persisted to storage (future: audit log)
   - State transitions logged in extension output

## Future Enhancements

1. **Provider health monitoring:** Periodically verify active provider is still reachable
2. **Fallback logic:** Switch to secondary provider if primary becomes unavailable
3. **Model listing:** Query `/v1/models` from active provider and show available models
4. **API key management:** Secure storage of remote provider authentication
5. **Provider-specific adapters:** Detect provider type and use optimized protocol
6. **User preferences:** Config options for default discovery behavior, timeouts, etc.
7. **Multi-provider stacking:** Allow chaining local and remote providers

## Testing the Implementation

### Manual Testing Workflow

1. **Initial state check:**
   - Open Lopilot chat → Badge shows "no-provider"
   - Send message → Assistant explains no provider available

2. **Local discovery:**
   - Run "Discover Local Providers" (if Ollama is running)
   - Badge changes to "local-available"
   - Run "Select Provider" → Pick discovered Ollama
   - Badge changes to "local-configured"
   - Send message → Should now handle request properly

3. **Remote opt-in:**
   - Run "Enable Remote Providers" → Confirmation dialog
   - If remote is configured → Badge changes to "remote-enabled"
   - Messages now warn about remote usage

4. **Disabling remote:**
   - Run "Disable Remote" (future command)
   - Badge changes back to local or no-provider state

### Key Assertions

- [ ] All 5 lifecycle states are reachable
- [ ] State transitions are deterministic
- [ ] Provider persistence survives extension reload
- [ ] Local discovery finds Ollama when running
- [ ] Remote requests blocked until explicit opt-in
- [ ] Chat messages reflect current provider state
- [ ] Status bar updates on every state change
- [ ] No TypeScript errors or lint issues

## Related Tasks

- **Next:** Build adapter contracts and implement streaming transport
- **After:** Integrate Ollama connector for MVP
- **Later:** Add LocalAI and generic OpenAI-compatible support
