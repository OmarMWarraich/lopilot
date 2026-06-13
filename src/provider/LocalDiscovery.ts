/**
 * Local provider discovery: scans for Ollama, LocalAI, and compatible endpoints
 * on standard ports and user-configured addresses.
 */

import { ProviderEndpoint } from "./ProviderState";

export interface DiscoveryOptions {
  /** Timeout in milliseconds for each health check attempt */
  timeoutMs?: number;
  /** Custom ports to scan (in addition to defaults) */
  customPorts?: number[];
  /** Custom hosts to check (in addition to defaults) */
  customHosts?: string[];
}

/**
 * Supported local provider types and their default port configurations.
 */
const KNOWN_PROVIDERS = [
  {
    type: "ollama" as const,
    defaultPorts: [11434],
    healthCheckPath: "/api/tags",
    name: "Ollama",
  },
  {
    type: "localai" as const,
    defaultPorts: [8080, 8000],
    healthCheckPath: "/v1/models",
    name: "LocalAI",
  },
];

const DEFAULT_HOSTS = ["localhost", "127.0.0.1"];

/**
 * Attempts to reach a provider endpoint and verify it's healthy.
 * Returns null if unreachable or unhealthy.
 */
async function checkHealthAsync(
  baseUrl: string,
  timeoutMs: number = 5000,
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Try /health endpoint first (generic)
      const response = await fetch(`${baseUrl}/health`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      // Try /v1/models as fallback (OpenAI-compat)
      const response = await fetch(`${baseUrl}/v1/models`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    }
  } catch {
    return false;
  }
}

/**
 * Discovers local model providers on the network.
 * Scans standard ports for Ollama, LocalAI, and OpenAI-compatible endpoints.
 */
export async function discoverLocalProviders(
  options: DiscoveryOptions = {},
): Promise<ProviderEndpoint[]> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const hosts = [...DEFAULT_HOSTS, ...(options.customHosts ?? [])];

  const discovered: ProviderEndpoint[] = [];
  const now = new Date().toISOString();

  // Scan all host + port combinations for known providers
  const allPorts = new Set<number>();
  KNOWN_PROVIDERS.forEach((p) =>
    p.defaultPorts.forEach((port) => allPorts.add(port)),
  );
  if (options.customPorts) {
    options.customPorts.forEach((port) => allPorts.add(port));
  }

  const checks: Promise<void>[] = [];

  for (const host of hosts) {
    for (const port of allPorts) {
      checks.push(
        (async () => {
          const baseUrl = `http://${host}:${port}`;
          const isHealthy = await checkHealthAsync(baseUrl, timeoutMs);

          if (isHealthy) {
            // Determine the provider type by trying specific health check endpoints
            let providerType:
              | "ollama"
              | "localai"
              | "openai-compat"
              | "unknown" = "unknown";

            // Check for Ollama-specific API
            try {
              const response = await fetch(`${baseUrl}/api/tags`, {
                signal: AbortSignal.timeout(timeoutMs),
              });
              if (response.ok) {
                providerType = "ollama";
              }
            } catch {
              // Not Ollama, try others
            }

            // Check for LocalAI-specific API
            if (providerType === "unknown") {
              try {
                const response = await fetch(`${baseUrl}/v1/models`, {
                  signal: AbortSignal.timeout(timeoutMs),
                });
                if (response.ok) {
                  // Could be LocalAI or generic OpenAI-compat
                  providerType = "localai";
                }
              } catch {
                // Not LocalAI
              }
            }

            discovered.push({
              id: `${providerType}-${host}-${port}`.toLowerCase(),
              name: `${providerType === "unknown" ? "Local Provider" : providerType.charAt(0).toUpperCase() + providerType.slice(1)} on ${host}:${port}`,
              type: providerType,
              baseUrl,
              isDiscovered: true,
              addedAt: now,
            });
          }
        })(),
      );
    }
  }

  // Wait for all checks to complete
  await Promise.all(checks);

  return discovered;
}

/**
 * Tests a specific endpoint URL to verify it's reachable and healthy.
 */
export async function testEndpoint(
  baseUrl: string,
  timeoutMs: number = 5000,
): Promise<boolean> {
  return checkHealthAsync(baseUrl, timeoutMs);
}
