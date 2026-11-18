import release from './appRelease.json';

export const APP_VERSION = release.version;
export const STORE_BUILD = process.env.EXPO_PUBLIC_STORE_BUILD === '1';
export const APP_NAME = STORE_BUILD ? (process.env.EXPO_PUBLIC_STORE_NAME?.trim() || 'My Buddy') : 'Gemma Chat';
export const SUPPORT_BASE_URL = process.env.EXPO_PUBLIC_SUPPORT_BASE_URL?.trim().replace(/\/+$/, '') || '';
