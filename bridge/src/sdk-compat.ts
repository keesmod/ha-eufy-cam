/** Compatibility for eufy-security-client 4.1.1-1; upstream PR #975.
 * Eufy returns application success 200 as well as legacy 0. Normalize only
 * successful HTTP responses, leaving all other codes and payloads unchanged.
 */
import { HTTPApi } from 'eufy-security-client';

export function normalizeSuccess<T extends { status: number; data: unknown }>(response: T): T {
  const data = response.data;
  if (response.status === 200 && data && typeof data === 'object' && !Array.isArray(data) && 'code' in data && data.code === 200) {
    return { ...response, data: { ...data, code: 0 } };
  }
  return response;
}

const request = HTTPApi.prototype.request;
HTTPApi.prototype.request = async function (...args: Parameters<typeof request>) {
  return normalizeSuccess(await request.apply(this, args));
};

/** The SDK's country lookup has no timeout, so boot-time network failures can
 * leave initialize() pending forever. Cancel that request before retrying;
 * racing initialize() itself would leave live SDK instances in the background.
 */
export async function resolveApiBase(country: string, request: typeof fetch = fetch, timeoutMs = 10_000): Promise<string> {
  if (!/^[A-Z]{2}$/.test(country)) throw new Error("Invalid country");
  const response = await request(`https://extend.eufylife.com/domain/${country}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error("Eufy country lookup failed");
  const result = await response.json() as { code?: unknown; data?: { domain?: unknown } };
  const domain = result?.data?.domain;
  if ((result?.code !== 0 && result?.code !== 200) || typeof domain !== "string" || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/i.test(domain)) throw new Error("Invalid Eufy country response");
  return `https://${domain}`;
}

HTTPApi.getApiBaseFromCloud = country => resolveApiBase(country);
