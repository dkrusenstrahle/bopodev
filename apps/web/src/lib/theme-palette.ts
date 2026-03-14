export const THEME_PALETTE_STORAGE_KEY = "bopodev-theme-palette";

export type ThemePaletteId = "default" | "graphite" | "vercel" | "square" | "orchid";

export const THEME_PALETTES: ReadonlyArray<{ id: ThemePaletteId; label: string }> = [
  { id: "default", label: "Default" },
  { id: "graphite", label: "Graphite" },
  { id: "vercel", label: "Vercel" },
  { id: "square", label: "Square" },
  { id: "orchid", label: "Orchid" },
] as const;

export function getStoredPalette(): ThemePaletteId {
  if (typeof window === "undefined") return "default";
  const raw = localStorage.getItem(THEME_PALETTE_STORAGE_KEY);
  if (raw === "graphite" || raw === "vercel" || raw === "square" || raw === "orchid" || raw === "default") return raw;
  return "default";
}

export function setStoredPalette(palette: ThemePaletteId): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(THEME_PALETTE_STORAGE_KEY, palette);
}
