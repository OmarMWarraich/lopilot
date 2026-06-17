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
import {
  discoverOllamaCapabilities,
  HealthResponse,
  ModelMetadata,
  OllamaCapabilityDiscovery,
} from "../adapter";

const STORAGE_KEY = "lopilot.provider.config.v1";
const SETTINGS_SECTION = "lopilot";

export type LocalBackendPreference = "ollama";

export interface ProviderPreferences {
  localBackend: LocalBackendPreference;
  ollamaBaseUrl: string;
  defaultModel: string | null;
}

export type ProviderAvailability =
  | "ready"
  | "not-selected"
  | "blocked"
  | "unsupported"
  | "unavailable"
  | "no-models";

export interface ProviderCapabilities {
  healthCheck: boolean;
  modelListing: boolean;
  chatStreaming: boolean;
  cancellation: boolean;
  tokenUsage: boolean;
}

export interface ProviderReadiness {
  availability: ProviderAvailability;
  detail: string;
  provider: ProviderEndpoint | null;
  health: HealthResponse | null;
  models: ModelMetadata[];
  capabilities: ProviderCapabilities;
}

const EMPTY_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  healthCheck: false,
  modelListing: false,
  chatStreaming: false,
  cancellation: false,
  tokenUsage: false,
};

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
      return {
        ...INITIAL_PROVIDER_CONFIG,
        discoveredLocal: [],
        configuredLocal: [],
        configuredRemote: [],
      };
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

  public getPreferences(): ProviderPreferences {
    const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    return {
      localBackend: normalizeLocalBackend(configuration.get<string>("localBackend")),
      ollamaBaseUrl: normalizeBaseUrl(configuration.get<string>("ollamaBaseUrl") ?? "http://localhost:11434"),
      defaultModel: normalizeOptionalString(configuration.get<string>("defaultModel")),
    };
  }

  public hasExplicitPreferences(): boolean {
    const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    return hasConfiguredValue(configuration, "localBackend") || hasConfiguredValue(configuration, "ollamaBaseUrl") || hasConfiguredValue(configuration, "defaultModel");
  }

  public async applyPreferences(options: { force?: boolean } = {}): Promise<ProviderEndpoint | null> {
    if (!options.force && !this.hasExplicitPreferences()) {
      return this.getActiveProvider();
    }

    const configuration = vscode.workspace.getConfiguration(SETTINGS_SECTION);
    const preferences = this.getPreferences();
    if (preferences.localBackend !== "ollama") {
      return this.getActiveProvider();
    }

    const endpoint = this.upsertConfiguredOllamaProvider(preferences.ollamaBaseUrl);
    this.config.activeProviderId = endpoint.id;

    if (hasConfiguredValue(configuration, "defaultModel")) {
      this.config.activeModelId = preferences.defaultModel;
    }

    this.config.lifecycleState = deriveProviderLifecycleState(this.config);
    await this.saveConfig();
    return endpoint;
  }

  public async getActiveProviderReadiness(): Promise<ProviderReadiness> {
    const provider = this.getActiveProvider();
    if (!provider) {
      return {
        availability: "not-selected",
        detail: "No active provider is selected.",
        provider: null,
        health: null,
        models: [],
        capabilities: EMPTY_PROVIDER_CAPABILITIES,
      };
    }

    if (!this.canSendRequest()) {
      return {
        availability: "blocked",
        detail: this.getStateDescription(),
        provider,
        health: null,
        models: [],
        capabilities: EMPTY_PROVIDER_CAPABILITIES,
      };
    }

    if (provider.type !== "ollama") {
      return {
        availability: "unsupported",
        detail: `Provider ${provider.name} does not expose connector capabilities yet.`,
        provider,
        health: null,
        models: [],
        capabilities: EMPTY_PROVIDER_CAPABILITIES,
      };
    }

    const discovery = await discoverOllamaCapabilities(provider.baseUrl);
    return toProviderReadiness(provider, discovery);
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

  /**
   * Chooses a smaller fallback model from the provided model list.
   * Returns the closest lower-footprint model when the active model appears too
   * large for the current machine, or the smallest available model when the
   * current selection is missing.
   */
  public chooseFallbackModel(models: ModelMetadata[], currentModelId: string | null): ModelMetadata | null {
    if (models.length === 0) {
      return null;
    }

    const orderedModels = [...models].sort(compareModelFootprint);
    if (!currentModelId) {
      return orderedModels[0] ?? null;
    }

    const currentModel = orderedModels.find((model) => model.id === currentModelId);
    if (!currentModel) {
      return orderedModels[0] ?? null;
    }

    const currentScore = scoreModelFootprint(currentModel);
    const smallerCandidates = orderedModels.filter((model) => model.id !== currentModelId && scoreModelFootprint(model) < currentScore);
    return smallerCandidates[smallerCandidates.length - 1] ?? null;
  }

  /**
   * Returns true when a model request failed for a reason that usually benefits
   * from retrying with a smaller local model.
   */
  public shouldFallbackToSmallerModel(error: unknown): boolean {
    if (!isAdapterErrorWithCode(error)) {
      return false;
    }

    return error.code === "out_of_memory" || error.code === "timeout";
  }

  private upsertConfiguredOllamaProvider(baseUrl: string): ProviderEndpoint {
    const existing = this.config.configuredLocal.find((provider) => {
      return provider.type === "ollama" && normalizeBaseUrl(provider.baseUrl) === baseUrl;
    });

    if (existing) {
      return existing;
    }

    const endpoint: ProviderEndpoint = {
      id: `ollama-configured-${slugifyEndpoint(baseUrl)}`,
      name: "Ollama (configured)",
      type: "ollama",
      baseUrl,
      isDiscovered: false,
      addedAt: new Date().toISOString(),
    };

    this.config.configuredLocal = [
      ...this.config.configuredLocal.filter((provider) => provider.id !== endpoint.id),
      endpoint,
    ];
    return endpoint;
  }
}

function normalizeLocalBackend(value: string | undefined): LocalBackendPreference {
  return value === "ollama" ? value : "ollama";
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "") || "http://localhost:11434";
}

function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function hasConfiguredValue(configuration: vscode.WorkspaceConfiguration, key: string): boolean {
  const inspection = configuration.inspect(key);
  return inspection?.globalValue !== undefined || inspection?.workspaceValue !== undefined || inspection?.workspaceFolderValue !== undefined;
}

function compareModelFootprint(left: ModelMetadata, right: ModelMetadata): number {
  const leftScore = scoreModelFootprint(left);
  const rightScore = scoreModelFootprint(right);

  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }

  return left.id.localeCompare(right.id);
}

function scoreModelFootprint(model: ModelMetadata): number {
  const sizeScore = typeof model.maxTokens === "number" ? model.maxTokens : Number.POSITIVE_INFINITY;
  const quantizationScore = parseQuantizationScore(model.quantization);
  return sizeScore * 100 + quantizationScore;
}

function parseQuantizationScore(quantization: string | null): number {
  if (!quantization) {
    return 999;
  }

  const match = quantization.match(/(?:^|[^0-9])([0-9]{1,2})(?:[^0-9]|$)/);
  if (!match) {
    return 999;
  }

  return Number(match[1]);
}

function isAdapterErrorWithCode(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

function slugifyEndpoint(baseUrl: string): string {
  return baseUrl.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}

function toProviderReadiness(provider: ProviderEndpoint, discovery: OllamaCapabilityDiscovery): ProviderReadiness {
  if (discovery.health.status === "unavailable") {
    return {
      availability: "unavailable",
      detail: discovery.failure ?? "Ollama is unavailable.",
      provider,
      health: discovery.health,
      models: [],
      capabilities: discovery.capabilities,
    };
  }

  if (!discovery.capabilities.modelListing) {
    return {
      availability: "unavailable",
      detail: discovery.failure ?? "Ollama model listing is unavailable.",
      provider,
      health: discovery.health,
      models: [],
      capabilities: discovery.capabilities,
    };
  }

  if (discovery.models.length === 0) {
    return {
      availability: "no-models",
      detail: discovery.failure ?? "No local Ollama models are installed.",
      provider,
      health: discovery.health,
      models: [],
      capabilities: discovery.capabilities,
    };
  }

  return {
    availability: "ready",
    detail: discovery.health.detail ?? `${discovery.models.length} model(s) available.`,
    provider,
    health: discovery.health,
    models: discovery.models,
    capabilities: discovery.capabilities,
  };
}
