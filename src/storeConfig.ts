import release from './appRelease.json';

export const APP_VERSION = release.version;
export const STORE_BUILD = process.env.EXPO_PUBLIC_STORE_BUILD === '1';
export const APP_NAME = release.name;
export const SUPPORT_BASE_URL = process.env.EXPO_PUBLIC_SUPPORT_BASE_URL?.trim().replace(/\/+$/, '') || '';
