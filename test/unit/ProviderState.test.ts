import { describe, expect, it } from 'vitest';

import {
  INITIAL_PROVIDER_CONFIG,
  ProviderConfig,
  ProviderEndpoint,
  canSendRequest,
  deriveProviderLifecycleState
} from '../../src/provider/ProviderState';

const localProvider: ProviderEndpoint = {
  id: 'ollama-localhost-11434',
  name: 'Ollama on localhost',
  type: 'ollama',
  baseUrl: 'http://localhost:11434',
  isDiscovered: true,
  addedAt: '2026-06-15T00:00:00.000Z'
};

const remoteProvider: ProviderEndpoint = {
  id: 'remote-openai-compatible',
  name: 'Remote OpenAI-compatible endpoint',
  type: 'openai-compat',
  baseUrl: 'https://example.invalid/v1',
  isDiscovered: false,
  addedAt: '2026-06-15T00:00:00.000Z',
  requiresAuth: true
};

describe('ProviderState', () => {
  it('models no-provider when nothing is available', () => {
    const config = makeConfig();

    expect(deriveProviderLifecycleState(config)).toBe('no-provider');
    expect(canSendRequest({ ...config, lifecycleState: 'no-provider' })).toBe(false);
  });

  it('models local-available before a local provider is selected', () => {
    const config = makeConfig({ discoveredLocal: [localProvider] });

    expect(deriveProviderLifecycleState(config)).toBe('local-available');
    expect(canSendRequest({ ...config, lifecycleState: 'local-available' })).toBe(false);
  });

  it('models local-configured after selecting a local provider', () => {
    const config = makeConfig({ discoveredLocal: [localProvider], activeProviderId: localProvider.id });

    expect(deriveProviderLifecycleState(config)).toBe('local-configured');
    expect(canSendRequest({ ...config, lifecycleState: 'local-configured' })).toBe(true);
  });

  it('blocks remote providers until explicit consent is present', () => {
    const config = makeConfig({ configuredRemote: [remoteProvider], activeProviderId: remoteProvider.id });

    expect(deriveProviderLifecycleState(config)).toBe('remote-configured-blocked');
    expect(canSendRequest({ ...config, lifecycleState: 'remote-configured-blocked' })).toBe(false);
  });

  it('models remote-enabled only when active remote provider has explicit consent', () => {
    const config = makeConfig({
      configuredRemote: [remoteProvider],
      activeProviderId: remoteProvider.id,
      remoteRequestsAllowed: true
    });

    expect(deriveProviderLifecycleState(config)).toBe('remote-enabled');
    expect(canSendRequest({ ...config, lifecycleState: 'remote-enabled' })).toBe(true);
  });

  it('keeps available local providers ahead of a selected but blocked remote', () => {
    const config = makeConfig({
      discoveredLocal: [localProvider],
      configuredRemote: [remoteProvider],
      activeProviderId: remoteProvider.id
    });

    expect(deriveProviderLifecycleState(config)).toBe('local-available');
  });
});

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    ...INITIAL_PROVIDER_CONFIG,
    ...overrides,
    discoveredLocal: overrides.discoveredLocal ?? [],
    configuredLocal: overrides.configuredLocal ?? [],
    configuredRemote: overrides.configuredRemote ?? []
  };
}