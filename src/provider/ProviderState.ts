/**
 * Provider state model representing all possible configurations of local and remote model providers.
 * Implements explicit state semantics for local-first resolution with required explicit user opt-in for remote.
 */

/**
 * Represents the lifecycle state of a provider configuration.
 *
 * - 'local-available': a local provider was discovered via auto-discovery but not yet configured
 * - 'local-configured': a local provider is actively selected and ready for use
 * - 'remote-configured-blocked': a remote provider is configured but requires explicit opt-in before requests are sent
 * - 'remote-enabled': remote requests are explicitly permitted by the user
 * - 'no-provider': no provider is available (no local discovery and no remote config)
 */
export type ProviderLifecycleState =
  | "local-available"
  | "local-configured"
  | "remote-configured-blocked"
  | "remote-enabled"
  | "no-provider";

/**
 * Metadata about a discovered or configured provider endpoint.
 */
export interface ProviderEndpoint {
  /** Unique identifier for this endpoint (e.g., 'ollama-localhost-11434') */
  id: string;

  /** Human-readable name (e.g., 'Ollama on localhost') */
  name: string;

  /** Provider type (e.g., 'ollama', 'localai', 'openai-compat') */
  type: "ollama" | "localai" | "openai-compat" | "unknown";

  /** Base URL of the provider endpoint */
  baseUrl: string;

  /** Whether this provider was auto-discovered vs. manually configured */
  isDiscovered: boolean;

  /** When this endpoint was discovered or configured (ISO timestamp) */
  addedAt: string;

  /** Optional API key for authentication (stored in secret storage) */
  requiresAuth?: boolean;
}

/**
 * Represents the complete provider configuration state,
 * including discovered and configured providers and the current active state.
 */
export interface ProviderConfig {
  /** Current lifecycle state */
  lifecycleState: ProviderLifecycleState;

  /** Local providers discovered via auto-discovery */
  discoveredLocal: ProviderEndpoint[];

  /** User-configured local providers */
  configuredLocal: ProviderEndpoint[];

  /** User-configured remote providers */
  configuredRemote: ProviderEndpoint[];

  /** Currently active provider (if any) */
  activeProviderId: string | null;

  /** Whether user has explicitly opted into remote requests */
  remoteRequestsAllowed: boolean;

  /** Timestamp of last successful discovery scan */
  lastDiscoveryTime?: string;
}

/**
 * Initial provider configuration state: no provider available.
 */
export const INITIAL_PROVIDER_CONFIG: ProviderConfig = {
  lifecycleState: "no-provider",
  discoveredLocal: [],
  configuredLocal: [],
  configuredRemote: [],
  activeProviderId: null,
  remoteRequestsAllowed: false,
};

/**
 * Derives the lifecycle state from the configuration.
 * Follows local-first preference and explicit opt-in rules.
 */
export function deriveProviderLifecycleState(
  config: Omit<ProviderConfig, "lifecycleState">,
): ProviderLifecycleState {
  // Prefer local-configured
  if (config.activeProviderId) {
    const active = [
      ...config.configuredLocal,
      ...config.discoveredLocal,
      ...config.configuredRemote,
    ].find((p) => p.id === config.activeProviderId);

    if (active) {
      // Determine the state based on the active provider type
      const isLocalConfigured = config.configuredLocal.some(
        (p) => p.id === config.activeProviderId,
      );
      if (isLocalConfigured) {
        return "local-configured";
      }

      const isLocalDiscovered = config.discoveredLocal.some(
        (p) => p.id === config.activeProviderId,
      );
      if (isLocalDiscovered) {
        // User has actively selected a discovered local provider — treat as configured
        return "local-configured";
      }

      // It's a remote provider
      return config.remoteRequestsAllowed
        ? "remote-enabled"
        : "remote-configured-blocked";
    }
  }

  // Check if local options are available
  if (config.configuredLocal.length > 0) {
    return "local-available";
  }

  if (config.discoveredLocal.length > 0) {
    return "local-available";
  }

  // Check if remote options are available
  if (config.configuredRemote.length > 0) {
    return config.remoteRequestsAllowed
      ? "remote-enabled"
      : "remote-configured-blocked";
  }

  return "no-provider";
}

/**
 * Determines whether requests can be sent to a provider in the current state.
 * Implements the local-first + explicit opt-in policy.
 */
export function canSendRequest(config: ProviderConfig): boolean {
  switch (config.lifecycleState) {
    case "local-configured":
      return !!config.activeProviderId;
    case "remote-enabled":
      return !!config.activeProviderId;
    case "local-available":
      // Provider is visible but not yet selected — user must configure
      return false;
    case "remote-configured-blocked":
      return false;
    case "no-provider":
      return false;
  }
}

/**
 * Returns a human-readable description of the provider state for UI display.
 */
export function getProviderStateDescription(
  state: ProviderLifecycleState,
): string {
  switch (state) {
    case "local-available":
      return "Local provider available - configure to use";
    case "local-configured":
      return "Using local provider";
    case "remote-configured-blocked":
      return "Remote provider blocked - explicit opt-in required";
    case "remote-enabled":
      return "Remote requests enabled";
    case "no-provider":
      return "No provider available - setup required";
  }
}
