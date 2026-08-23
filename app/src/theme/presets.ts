import { CustomTheme } from './themeEngine';

/** Built-in theme presets. Users cannot delete these. */
export const BUILTIN_THEMES: CustomTheme[] = [
  {
    id: 'default-dark',
    name: 'Default Dark',
    isDark: true,
    isBuiltin: true,
    palette: {
      bg: '#101114',
      surface: '#1b1c20',
      primary: '#2aabee',
      secondary: '#63a9ff',
      text: '#f7f7f5',
      subtext: '#b2b3ba',
      border: 'rgba(255, 255, 255, 0.1)',
      hover: 'rgba(255, 255, 255, 0.055)',
    },
  },
  {
    id: 'default-light',
    name: 'Default Light',
    isDark: false,
    isBuiltin: true,
    palette: {
      bg: '#f5f5f2',
      surface: '#fbfbf9',
      primary: '#168ac3',
      secondary: '#2479c8',
      text: '#1b1c1f',
      subtext: '#5d6068',
      border: 'rgba(0, 0, 0, 0.1)',
      hover: 'rgba(27, 28, 31, 0.05)',
    },
  },
  {
    id: 'boxify',
    name: 'Boxify',
    isDark: false,
    isBuiltin: true,
    palette: {
      bg: '#eef1f7',
      surface: '#ffffff',
      primary: '#03a9f4',
      secondary: '#3f51b5',
      text: '#37474f',
      subtext: '#8a94a6',
      border: 'rgba(15, 23, 42, 0.08)',
      hover: 'rgba(15, 23, 42, 0.04)',
      sidebarBg: '#3f51b5',
      sidebarText: 'rgba(255, 255, 255, 0.94)',
      sidebarTextMuted: 'rgba(255, 255, 255, 0.62)',
      sidebarActiveBg: 'rgba(255, 255, 255, 0.14)',
      sidebarBorder: 'rgba(255, 255, 255, 0.14)',
    },
  },
];

/** Default palette values to seed a new custom theme. */
export function getDefaultPalette(isDark: boolean) {
  const base = isDark
    ? BUILTIN_THEMES.find(t => t.id === 'default-dark')!
    : BUILTIN_THEMES.find(t => t.id === 'default-light')!;
  return { ...base.palette };
}
