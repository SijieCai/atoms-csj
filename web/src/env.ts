export type ClientAppEnv = 'development' | 'production';

const rawEnv = (import.meta.env.VITE_APP_ENV || (import.meta.env.PROD ? 'production' : 'development'))
  .trim()
  .toLowerCase();

export const APP_ENV: ClientAppEnv = rawEnv === 'production' ? 'production' : 'development';
export const IS_PROD = APP_ENV === 'production';
export const CONFIGURED_PUBLIC_URL = (import.meta.env.VITE_PUBLIC_URL || '').trim().replace(/\/+$/, '');

export function getPublicOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return CONFIGURED_PUBLIC_URL;
}
