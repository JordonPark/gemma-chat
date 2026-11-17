import { Appearance } from 'react-native';

const dark = Appearance.getColorScheme() === 'dark';

export const colors = dark
  ? {
      bg: '#0f1115',
      card: '#1a1d23',
      border: '#2a2e36',
      text: '#e8eaed',
      muted: '#9aa0a6',
      accent: '#4c8bf5',
      userBubble: '#2b4e8c',
      botBubble: '#1f232a',
      danger: '#ef5350',
    }
  : {
      bg: '#f6f7f9',
      card: '#ffffff',
      border: '#e1e4e8',
      text: '#1f2328',
      muted: '#6a737d',
      accent: '#1a73e8',
      userBubble: '#1a73e8',
      botBubble: '#ffffff',
      danger: '#d93025',
    };

export const isDark = dark;
