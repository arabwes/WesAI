// API client + shared types. In dev, Vite proxies /api to the backend.

const BASE = "";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${path}: ${res.status} ${text}`);
  }
  return res.json();
}

// ---------- types ----------

export interface CameraHealth {
  state: string;
  last_frame_at: string | null;
  frames_received: number;
  frames_processed: number;
  processing_fps: number;
  processing_latency_ms: number;
  decode_errors: number;
  reconnect_attempts: number;
  last_error: string | null;
}

export interface LineCfg {
  line_id: string;
  name: string;
  points: number[][];
  direction_in: "up" | "down" | "left" | "right";
  hysteresis_px?: number;
  cooldown_seconds?: number;
  min_displacement_px?: number;
}

export interface ZoneCfg {
  zone_id: string;
  name: string;
  type: string;
  points: number[][];
}

export interface Camera {
  camera_id: string;
  name: string;
  enabled: boolean;
  source_type: string;
  role: string[];
  lines: LineCfg[];
  zones: ZoneCfg[];
  ignore_zones: ZoneCfg[];
  processing: Record<string, unknown>;
  health: CameraHealth | null;
}

export interface Visit {
  visit_id: string;
  entry_time: string | null;
  exit_time: string | null;
  dwell_seconds: number | null;
  status: string;
  entry_camera: string | null;
  current_camera: string | null;
  current_zone: string | null;
  match_confidence: number;
  handoff_count: number;
  cameras_observed: number;
  completion_reason: string | null;
  is_demo: boolean;
  observations?: {
    camera_id: string;
    camera_track_id: string;
    first_seen: string;
    last_seen: string;
    zone: string | null;
    confidence: number;
  }[];
}

export interface EventRow {
  event_id: number;
  event_type: string;
  timestamp: string;
  camera_id: string | null;
  visit_id: string | null;
  track_id: string | null;
  confidence: number;
  metadata: Record<string, unknown>;
  is_demo: boolean;
}

export interface Overview {
  demo_mode: boolean;
  customers_today: number;
  current_occupancy: number;
  peak_occupancy: number;
  peak_at: string | null;
  avg_dwell_seconds: number | null;
  median_dwell_seconds: number | null;
  completion_rate: number | null;
  cameras_online: number;
  cameras_total: number;
  visitors_by_hour: { hour: string; entries: number; exits: number }[];
  occupancy_timeline: { time: string; occupancy: number }[];
  dwell_buckets: { bucket: string; count: number }[];
}

export interface DwellStats {
  count: number;
  avg_seconds: number | null;
  median_seconds: number | null;
  p25_seconds: number | null;
  p75_seconds: number | null;
  p90_seconds: number | null;
}

export interface DwellSummary {
  high_confidence: DwellStats;
  all_completed: DwellStats;
  lost_count: number;
  uncertain_count: number;
  buckets: { bucket: string; count: number }[];
  by_hour_of_entry: ({ hour: number } & DwellStats)[];
  by_weekday: ({ weekday: string } & DwellStats)[];
}

export interface SystemStatus {
  backend: string;
  database: string;
  demo_mode: boolean;
  pipeline_running: boolean;
  camera_workers_alive: number;
  cameras: Record<string, CameraHealth>;
  queue_depth: number | null;
  appearance_vectors_held: number;
  disk: { total_gb: number; free_gb: number };
  cpu_percent?: number;
  memory_percent?: number;
}

// ---------- calls ----------

export const api = {
  health: () => get<{ status: string; version: string }>("/api/health"),
  systemStatus: () => get<SystemStatus>("/api/system/status"),
  cameras: () => get<Camera[]>("/api/cameras"),
  camera: (id: string) => get<Camera>(`/api/cameras/${id}`),
  reloadCameras: () => send<Record<string, string[]>>("/api/cameras/reload", "POST"),
  overview: (range?: string) => get<Overview>(`/api/analytics/overview${range ?? ""}`),
  traffic: (range?: string) => get<any>(`/api/analytics/traffic${range ?? ""}`),
  occupancy: (range?: string) => get<any>(`/api/analytics/occupancy${range ?? ""}`),
  dwell: (range?: string) => get<DwellSummary>(`/api/analytics/dwell${range ?? ""}`),
  quality: (range?: string) => get<any>(`/api/analytics/tracking-quality${range ?? ""}`),
  visits: (params?: string) => get<{ visits: Visit[] }>(`/api/visits${params ?? ""}`),
  visit: (id: string) => get<Visit>(`/api/visits/${id}`),
  activeVisits: () => get<{ visits: Visit[] }>("/api/visits/active"),
  events: (params?: string) => get<{ events: EventRow[] }>(`/api/events${params ?? ""}`),
  recentEvents: (limit = 50) => get<{ events: EventRow[] }>(`/api/events/recent?limit=${limit}`),
  topology: () => get<{ transitions: any[] }>("/api/calibration/topology"),
  saveCalibration: (cameraId: string, payload: unknown) =>
    send<Record<string, unknown>>(`/api/calibration/${cameraId}`, "PUT", payload),
};

export function fmtDwell(seconds: number | null | undefined): string {
  if (seconds == null) return "–";
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s.toString().padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, "0")}m`;
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "–";
  return new Date(iso).toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
