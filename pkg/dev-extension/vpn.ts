// The shared VPN, from the dashboard: its state (dev-api's /vpn, watched), the person's login with
// a one-time code, "not now", and logging out. See dev-api's "The shared VPN" section and vpn-pod.mjs.
import { devApi } from './reviews';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export const VPN_PATH = '/vpn';

export interface VpnAsk {
  /** The workspace that asked, or what said it was asking. */
  who: string;
  reason: string;
  at: string;
}

export interface VpnStatus {
  phase: 'connected' | 'connecting' | 'challenge' | 'reconnecting' | 'need-login' | 'failed' | 'down' | 'starting' | 'off';
  note: string;
  since: string;
  address: string;
  /** Whether the secret store holds what a login needs; `missing` names what it does not. */
  configured: boolean;
  missing: string[];
  /** Things waiting for the person to log in, newest last. Empty while connected. */
  asks: VpnAsk[];
}

export function vpnLogin(otp: string): Promise<VpnStatus> {
  return devApi('/vpn/login', { method: 'POST', body: JSON.stringify({ otp }) }) as Promise<VpnStatus>;
}

export function vpnDismiss(): Promise<Json> {
  return devApi('/vpn/dismiss', { method: 'POST', body: '{}' });
}

export function vpnLogout(): Promise<Json> {
  return devApi('/vpn/logout', { method: 'POST', body: '{}' });
}

/** The word for a phase, as the Tools card and the prompt say it. */
export function vpnPhaseWord(phase: VpnStatus['phase'] | undefined): string {
  return ({
    connected: 'Connected', connecting: 'Connecting', challenge: 'Connecting', reconnecting: 'Reconnecting', 'need-login': 'Needs a login', failed: 'Login failed', down: 'Down', starting: 'Starting', off: 'Off',
  } as Record<string, string>)[phase || 'off'] || String(phase || '');
}
