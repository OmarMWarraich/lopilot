import { ModelMetadata } from '../adapter';

export type ProviderScope = 'local' | 'remote';

export type ProviderResolutionState =
  | 'local-available'
  | 'local-configured'
  | 'remote-configured-blocked'
  | 'remote-enabled'
  | 'unavailable';

export interface ProviderCapabilitySet {
  supportsStreaming: boolean;
  supportsEmbeddings: boolean;
  supportsProvenance: boolean;
  supportsToolStatus: boolean;
}

export interface ProviderHealth {
  status: 'ok' | 'degraded' | 'unavailable';
  detail?: string;
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  scope: ProviderScope;
  endpoint: string;
}

export interface ProviderResolution {
  state: ProviderResolutionState;
  activeProviderId?: string;
  availableProviders: ProviderDescriptor[];
  requiresRemoteConsent: boolean;
}

export interface ConnectorContext {
  workspaceId?: string;
  consentToRemoteCodeTransfer: boolean;
}

export interface ModelConnector {
  readonly descriptor: ProviderDescriptor;
  readonly capabilities: ProviderCapabilitySet;
  discoverModels(): Promise<ModelMetadata[]>;
  healthCheck(): Promise<ProviderHealth>;
  resolve(context: ConnectorContext): Promise<ProviderResolution>;
}
