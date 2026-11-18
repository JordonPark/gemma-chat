import { Appearance } from 'react-native';

const dark = Appearance.getColorScheme() === 'dark';

export const colors = dark
  ? {
      bg: '#171421',
      card: '#221D30',
      border: '#3C344E',
      text: '#F7F2FF',
      muted: '#BEB3CE',
      accent: '#8152DC',
      accentText: '#D9BEFF',
      accentSoft: '#33244B',
      userBubble: '#59378E',
      botBubble: '#241F32',
      danger: '#BB3D57',
    }
  : {
      bg: '#F7F4FC',
      card: '#FFFFFF',
      border: '#E5DDEF',
      text: '#221834',
      muted: '#675B78',
      accent: '#6336B6',
      accentText: '#582D9C',
      accentSoft: '#EEE5FB',
      userBubble: '#6336B6',
      botBubble: '#FFFFFF',
      danger: '#AE2846',
    };

export const isDark = dark;
