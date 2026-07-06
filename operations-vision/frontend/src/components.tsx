import { ReactNode } from "react";

export function Stat(props: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="panel stat">
      <div className="label">{props.label}</div>
      <div className="value">{props.value}</div>
      {props.sub != null && <div className="sub">{props.sub}</div>}
    </div>
  );
}

export function Panel(props: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`panel ${props.className ?? ""}`}>
      {props.title && <h2>{props.title}</h2>}
      {props.children}
    </div>
  );
}

export function StatusBadge({ state }: { state: string }) {
  const color =
    state === "online" || state === "completed" || state === "ok"
      ? "green"
      : state === "reconnecting" || state === "uncertain" || state === "active"
        ? state === "active" ? "blue" : "yellow"
        : state === "offline" || state === "lost" || state === "error"
          ? "red"
          : "gray";
  return <span className={`badge ${color}`}>{state}</span>;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="error-box">Failed to reach the backend: {error}</div>;
}

export const CHART_COLORS = {
  entries: "#4fb3ff",
  exits: "#bc8cff",
  occupancy: "#3fb950",
  dwell: "#d29922",
  grid: "#2a3542",
  text: "#8b98a5",
};
