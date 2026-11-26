import type { AuthPolicyConfig } from '../types';

export type AuthModeTab = 'password' | 'email_otp' | 'passkey' | 'device';

export function getEnabledAuthModes(policy: AuthPolicyConfig): AuthModeTab[] {
  const modes: AuthModeTab[] = [];
  if (policy.enablePasswordArgon2id) modes.push('password');
  if (policy.enableEmailOtpMagicLink) modes.push('email_otp');
  if (policy.enablePasskeysWebAuthn) modes.push('passkey');
  if (policy.enableDeviceFlowRfc8628) modes.push('device');
  return modes;
}

export function resolveActiveAuthMode(
  policy: AuthPolicyConfig,
  requested: AuthModeTab | null
): AuthModeTab | null {
  const enabled = getEnabledAuthModes(policy);
  if (enabled.length === 0) return null;
  if (requested && enabled.includes(requested)) return requested;
  return enabled[0];
}
