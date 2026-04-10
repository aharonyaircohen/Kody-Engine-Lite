/**
 * @fileOverview Event System — Dashboard Endpoints Parser
 * @fileType utility
 *
 * Parse KODY_DASHBOARD_ENDPOINTS env var.
 * Format: "name1:url1,name2:url2,name3:url3"
 */

export interface DashboardEndpoint {
  name: string;
  url: string;
}

export function parseDashboardEndpoints(envVar: string | undefined): DashboardEndpoint[] {
  if (!envVar) return [];
  return envVar
    .split(",")
    .map((entry) => {
      const idx = entry.indexOf(":");
      if (idx === -1) return null;
      const name = entry.slice(0, idx).trim();
      const url = entry.slice(idx + 1).trim();
      if (!name || !url) return null;
      return { name, url };
    })
    .filter((e): e is DashboardEndpoint => e !== null);
}

export function resolveDashboardUrl(name: string, endpoints: DashboardEndpoint[]): string | null {
  return endpoints.find((e) => e.name === name)?.url ?? null;
}
