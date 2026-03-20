export const THEME_PALETTE_STORAGE_KEY = "bopodev-theme-palette";

export type ThemePaletteId = "default" | "graphite" | "square" | "orchid" | "brownie";

export const THEME_PALETTES: ReadonlyArray<{ id: ThemePaletteId; label: string }> = [
  { id: "default", label: "Default" },
  { id: "graphite", label: "Graphite" },
  { id: "square", label: "Square" },
  { id: "orchid", label: "Orchid" },
  { id: "brownie", label: "Brownie" },
] as const;

export function getStoredPalette(): ThemePaletteId {
  if (typeof window === "undefined") return "default";
  const raw = localStorage.getItem(THEME_PALETTE_STORAGE_KEY);
  if (raw === "graphite" || raw === "square" || raw === "orchid" || raw === "brownie" || raw === "default") return raw;
  return "default";
}

export function setStoredPalette(palette: ThemePaletteId): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(THEME_PALETTE_STORAGE_KEY, palette);
}
