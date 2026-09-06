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
