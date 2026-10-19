export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, exp);
  const digits = value >= 100 || exp === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[exp]}`;
}

export function normalizeExtension(value: string): string {
  return String(value || "").trim().toLowerCase().replace(/^\./, "");
}

export function monthsAgo(modifiedAt: number | null): number {
  if (!modifiedAt) return 0;
  return Math.max(0, Math.round((Date.now() - modifiedAt) / (30 * 24 * 60 * 60 * 1000)));
}

const PALETTE = [
  "#5b8def", "#e0709a", "#cf5450", "#7b6ef0", "#9a5cc4", "#2e9e8f", "#57a15a",
  "#c98a3f", "#4aa6bb", "#b0568a", "#6b7d99", "#3f9d6b", "#d0894a", "#8a83f0"
];

export function paletteColor(index: number): string {
  return PALETTE[((index % PALETTE.length) + PALETTE.length) % PALETTE.length] as string;
}

const CATEGORY_COLORS: Record<string, string> = {
  images: "#5b8def",
  videos: "#e0709a",
  audio: "#9a5cc4",
  archives: "#c98a3f",
  documents: "#2e9e8f",
  code: "#7b6ef0",
  data: "#4aa6bb",
  apps: "#57a15a",
  other: "#6b7d99"
};

export function categoryColor(category: string): string {
  return CATEGORY_COLORS[category] || "#6b7d99";
}

export function reasonColor(category: "duplicate" | "cache" | "other"): string {
  if (category === "duplicate") return "#cf5450";
  if (category === "cache") return "#b0742c";
  return "#6b7d99";
}

export function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const n = Number.parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
