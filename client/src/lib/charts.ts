import type { ReactNode } from "react";

export const CHART_TICK = { fill: "#7d8590", fontSize: 11 };
export const CHART_GRID_COLOR = "#30363d";
export const CHART_TOOLTIP_STYLE: React.CSSProperties = {
  background: "#161b22",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 12,
  color: "#e6edf3",
};

export function formatChartTick(ts: ReactNode): string {
  const d = new Date(String(ts));
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function formatPercentValue(value: unknown): string {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "—";
}
