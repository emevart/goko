export type SafeFailure = { class: string; status?: number };
export class CloudProbeError extends Error { readonly code: string; constructor(code: string); }
export function inheritedProxySettings(env?: Record<string, string | undefined>): Record<string, string>;
export function verifyCloudLiveSDK(root: string): { agents: string; openai: string; ws: string };
export function safeFailure(error: unknown): SafeFailure;
export function installCloudLiveTransport(options?: { authorized?: boolean; proxyEnv?: Record<string, string>; onFailure?: (error: SafeFailure) => void }): {
  readonly handshakes: number; close(): void; uninstall(): void;
};
