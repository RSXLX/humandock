export type AppMode = 'demo' | 'me';
export function parseMode(value: string | undefined): AppMode {
  if (value === undefined) return 'demo';
  if (value !== 'demo' && value !== 'me') throw new Error('APP_MODE must be exactly demo or me. Unknown modes never fall back to demo.');
  return value;
}
export function validateBindHost(mode: AppMode, host: string) {
  if (mode === 'demo' && !['127.0.0.1','localhost','::1'].includes(host)) {
    throw new Error('Local demo must bind to loopback. Do not expose demo identities or credits to a public network.');
  }
}
