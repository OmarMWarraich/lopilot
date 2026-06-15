/**
 * ProviderManager orchestrates provider discovery, configuration, and state management.
 * Implements local-first resolution with explicit remote opt-in.
 */

import * as vscode from "vscode";

import {
  INITIAL_PROVIDER_CONFIG,
  ProviderConfig,
  ProviderEndpoint,
  ProviderLifecycleState,
  canSendRequest,
  deriveProviderLifecycleState,
  getProviderStateDescription,
} from "./ProviderState";
import {
  discoverLocalProviders,
  DiscoveryOptions,
  fetchOllamaModels,
  testEndpoint,
} from "./LocalDiscovery";
import { ModelMetadata } from "../adapter";

const STORAGE_KEY = "lopilot.provider.config.v1";

export class ProviderManager {
  private config: ProviderConfig;
  private isDiscovering = false;

  public constructor(private readonly storage: vscode.Memento) {
    this.config = this.loadConfig();
  }

  /**
   * Loads the persisted provider configuration from storage.
   */
  private loadConfig(): ProviderConfig {
    const persisted = this.storage.get<Partial<ProviderConfig>>(STORAGE_KEY);

    if (!persisted) {
      return INITIAL_PROVIDER_CONFIG;
    }

    const config: ProviderConfig = {
      lifecycleState: "no-provider", // Will be derived
      discoveredLocal: persisted.discoveredLocal ?? [],
      configuredLocal: persisted.configuredLocal ?? [],
      configuredRemote: persisted.configuredRemote ?? [],
      activeProviderId: persisted.activeProviderId ?? null,
      activeModelId: persisted.activeModelId ?? null,
      remoteRequestsAllowed: persisted.remoteRequestsAllowed ?? false,
      lastDiscoveryTime: persisted.lastDiscoveryTime,
    };

    // Always derive the lifecycle state on load
    config.lifecycleState = deriveProviderLifecycleState(config);

    return config;
  }

  /**
   * Persists the current configuration to storage.
   */
  private async saveConfig(): Promise<void> {
    await this.storage.update(STORAGE_KEY, this.config);
  }

  private hasLocalProvider(): boolean {
    return (
      this.config.configuredLocal.length > 0 ||
      this.config.discoveredLocal.length > 0
    );
  }

  /**
   * Returns the current provider configuration.
   */
  public getConfig(): Readonly<ProviderConfig> {
    return Object.freeze({
      ...this.config,
      discoveredLocal: [...this.config.discoveredLocal],
      configuredLocal: [...this.config.configuredLocal],
      configuredRemote: [...this.config.configuredRemote],
    });
  }

  /**
   * Returns the current lifecycle state.
   */
  public getLifecycleState(): ProviderLifecycleState {
    return this.config.lifecycleState;
  }

  /**
   * Returns a human-readable description of the current provider state.
   */
  public getStateDescription(): string {
    return getProviderStateDescription(this.config.lifecycleState);
  }

  /**
   * Returns the currently active provider endpoint, if any.
   */
  public getActiveProvider(): ProviderEndpoint | null {
    if (!this.config.activeProviderId) {
      return null;
    }

    const allProviders = [
      ...this.config.configuredLocal,
      ...this.config.discoveredLocal,
      ...this.config.configuredRemote,
    ];

    return (
      allProviders.find((p) => p.id === this.config.activeProviderId) ?? null
    );
  }

  /**
   * Returns true if requests can be sent in the current provider state.
   */
  public canSendRequest(): boolean {
    return canSendRequest(this.config);
  }

  /**
   * Discovers local providers on the network.
   * Replaces previous discovered providers with fresh discovery results.
   */
  public async discoverLocal(
    options?: DiscoveryOptions,
  ): Promise<ProviderEndpoint[]> {
    if (this.isDiscovering) {
      // Return cached results so callers can distinguish "scan in progress" from "none found"
      return [...this.config.discoveredLocal];
    }

    this.isDiscovering = true;

    try {
      const discovered = await discoverLocalProviders(options);

      // Update config with newly discovered providers
      this.config.discoveredLocal = discovered;
      this.config.lastDiscoveryTime = new Date().toISOString();

      // Re-derive lifecycle state and update
      this.config.lifecycleState = deriveProviderLifecycleState(this.config);

      await this.saveConfig();

      return discovered;
    } finally {
      this.isDiscovering = false;
    }
  }

  /**
   * Registers a user-configured local provider.
   * Tests the endpoint before adding it.
   */
  public async registerLocalProvider(
    baseUrl: string,
    name: string,
  ): Promise<ProviderEndpoint | null> {
    // Normalize the URL
    const normalized = baseUrl.trim().replace(/\/$/, "");

    // Test the endpoint
    const isHealthy = await testEndpoint(normalized);

    if (!isHealthy) {
      return null;
    }

    const endpoint: ProviderEndpoint = {
      id: `local-custom-${Date.now()}`,
      name,
      type: "openai-compat", // Start with generic type; can be refined
      baseUrl: normalized,
      isDiscovered: false,
      addedAt: new Date().toISOString(),
    };

    this.config.configuredLocal.push(endpoint);
    this.config.lifecycleState = deriveProviderLifecycleState(this.config);

    await this.saveConfig();

    return endpoint;
  }

  /**
   * Registers a remote provider.
   * Does NOT automatically enable remote requests; user must call enableRemote().
   */
  public async registerRemoteProvider(
    baseUrl: string,
    name: string,
    apiKeyId?: string,
  ): Promise<ProviderEndpoint | null> {
    const normalized = baseUrl.trim().replace(/\/$/, "");

    // Optionally test the endpoint
    const isHealthy = await testEndpoint(normalized);

    if (!isHealthy) {
      return null;
    }

    const endpoint: ProviderEndpoint = {
      id: `remote-${Date.now()}`,
      name,
      type: "openai-compat",
      baseUrl: normalized,
      isDiscovered: false,
      addedAt: new Date().toISOString(),
      requiresAuth: !!apiKeyId,
    };

    this.config.configuredRemote.push(endpoint);
    this.config.lifecycleState = deriveProviderLifecycleState(this.config);

    await this.saveConfig();

    return endpoint;
  }

  /**
   * Activates a provider.
   * Only succeeds if the provider exists and is reachable.
   * Selecting a remote provider does not enable remote requests; the user must opt in separately.
   */
  public async setActiveProvider(providerId: string): Promise<boolean> {
    const allProviders = [
      ...this.config.configuredLocal,
      ...this.config.discoveredLocal,
      ...this.config.configuredRemote,
    ];

    const provider = allProviders.find((p) => p.id === providerId);

    if (!provider) {
      return false;
    }

    // Verify the provider is still healthy
    const isHealthy = await testEndpoint(provider.baseUrl);

    if (!isHealthy) {
      return false;
    }

    if (this.config.activeProviderId !== providerId) {
      this.config.activeModelId = null;
    }
    this.config.activeProviderId = providerId;

    this.config.lifecycleState = deriveProviderLifecycleState(this.config);

    await this.saveConfig();

    return true;
  }

  /**
   * Enables remote requests after explicit user consent.
   * Activates the first available remote provider only when no local provider is available.
   */
  public async enableRemote(): Promise<boolean> {
    this.config.remoteRequestsAllowed = true;

    // Preserve local-first behavior: do not auto-select a remote while local providers are available.
    if (
      !this.config.activeProviderId &&
      !this.hasLocalProvider() &&
      this.config.configuredRemote.length > 0
    ) {
      const firstRemote = this.config.configuredRemote[0];
      return this.setActiveProvider(firstRemote.id);
    }

    this.config.lifecycleState = deriveProviderLifecycleState(this.config);

    await this.saveConfig();

    return true;
  }

  /**
   * Disables remote requests.
   * If the active provider is remote, deactivates it first.
   */
  public async disableRemote(): Promise<void> {
    this.config.remoteRequestsAllowed = false;

    // If active provider is remote, deactivate it
    if (this.config.activeProviderId) {
      const active = this.config.configuredRemote.find(
        (p) => p.id === this.config.activeProviderId,
      );

      if (active) {
        this.config.activeProviderId = null;
      }
    }

    this.config.lifecycleState = deriveProviderLifecycleState(this.config);

    await this.saveConfig();
  }

  /**
   * Removes a provider configuration.
   * If it's the active provider, deactivates it first.
   */
  public async removeProvider(providerId: string): Promise<boolean> {
    if (this.config.activeProviderId === providerId) {
      this.config.activeProviderId = null;
    }

    let removed = false;

    this.config.configuredLocal = this.config.configuredLocal.filter((p) => {
      if (p.id === providerId) {
        removed = true;
        return false;
      }
      return true;
    });

    this.config.configuredRemote = this.config.configuredRemote.filter((p) => {
      if (p.id === providerId) {
        removed = true;
        return false;
      }
      return true;
    });

    if (removed) {
      this.config.lifecycleState = deriveProviderLifecycleState(this.config);
      await this.saveConfig();
    }

    return removed;
  }

  /**
   * Clears all discovered providers (e.g., before a fresh discovery scan).
   */
  public async clearDiscoveredProviders(): Promise<void> {
    this.config.discoveredLocal = [];
    this.config.lifecycleState = deriveProviderLifecycleState(this.config);
    await this.saveConfig();
  }

  /**
   * Lists the models available on the currently active provider.
   * Returns an empty array if no provider is active or the provider is not Ollama.
   */
  public async listModels(): Promise<ModelMetadata[]> {
    const provider = this.getActiveProvider();
    if (!provider || !this.canSendRequest()) {
      return [];
    }
    if (provider.type === 'ollama') {
      return fetchOllamaModels(provider.baseUrl);
    }
    return [];
  }

  /**
   * Returns the currently active model id, or null if none has been selected.
   */
  public getActiveModelId(): string | null {
    return this.config.activeModelId ?? null;
  }

  /**
   * Sets the active model id and persists it.
   */
  public async setActiveModelId(modelId: string): Promise<void> {
    this.config.activeModelId = modelId;
    await this.saveConfig();
  }
}
