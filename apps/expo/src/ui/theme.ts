import { Platform } from "react-native";

const sansFontFamily = Platform.select({
  android: "Noto Sans SC",
  ios: "PingFang SC",
  web: '"PingFang SC", "Noto Sans SC", "Source Han Sans SC", -apple-system, BlinkMacSystemFont, "Microsoft YaHei", system-ui, sans-serif',
  default: "System",
});

const monoFontFamily = Platform.select({
  android: "monospace",
  ios: "SF Mono",
  web: '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Consolas, monospace',
  default: "monospace",
});

export const colors = {
  background: "#fbfaf7",
  paper: "#ffffff",
  panel: "#efece4",
  selected: "#e7e2d6",
  foreground: "#1a1a14",
  ink2: "#3d3c34",
  mutedForeground: "#75736a",
  faint: "#a8a6a0",
  border: "rgba(26,26,20,0.08)",
  borderSoft: "rgba(26,26,20,0.05)",
  coral: "#e85a4a",
  coralSoft: "#f5d6cf",
  success: "#2eb872",
  danger: "#c44f3d",
} as const;

export const typography = {
  sans: {
    fontFamily: sansFontFamily,
  },
  mono: {
    fontFamily: monoFontFamily,
  },
  sectionTitle: {
    fontFamily: sansFontFamily,
    fontSize: 15,
    fontWeight: "700" as const,
    lineHeight: 20,
  },
  body: {
    fontFamily: sansFontFamily,
    fontSize: 13.5,
    fontWeight: "400" as const,
    lineHeight: 21,
  },
  cardTitle: {
    fontFamily: sansFontFamily,
    fontSize: 13,
    fontWeight: "600" as const,
    lineHeight: 18,
  },
  secondaryBody: {
    fontFamily: sansFontFamily,
    fontSize: 12.5,
    fontWeight: "400" as const,
    lineHeight: 18,
  },
  meta: {
    fontFamily: sansFontFamily,
    fontSize: 12,
    fontWeight: "400" as const,
    lineHeight: 16,
  },
  caption: {
    fontFamily: sansFontFamily,
    fontSize: 11.5,
    fontWeight: "400" as const,
    lineHeight: 15,
  },
  monoMeta: {
    fontFamily: monoFontFamily,
    fontSize: 11,
    fontWeight: "500" as const,
    lineHeight: 14,
  },
  pill: {
    fontFamily: monoFontFamily,
    fontSize: 9.5,
    fontWeight: "600" as const,
    lineHeight: 12,
    letterSpacing: 0.3,
    textTransform: "uppercase" as const,
  },
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
} as const;

export const radii = {
  panel: 14,
  card: 16,
  cardCompact: 8,
  button: 8,
  pill: 7,
  chip: 4,
  input: 14,
} as const;

export const shadows = {
  composer: {
    shadowColor: "#14140f",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 16,
    elevation: 2,
  },
  card: {
    shadowColor: "#14140f",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
    elevation: 1,
  },
} as const;

export const theme = {
  colors,
  fontFamilies: {
    sans: sansFontFamily,
    mono: monoFontFamily,
  },
  typography,
  spacing,
  radii,
  shadows,
} as const;

export type AppTheme = typeof theme;
