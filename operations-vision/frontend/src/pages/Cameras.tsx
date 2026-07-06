import { useState } from "react";
import { Camera, api, fmtDateTime } from "../api";
import { ErrorBox, Panel, StatusBadge } from "../components";
import { usePolling } from "../hooks";

function CameraCard({ cam }: { cam: Camera }) {
  const [showPreview, setShowPreview] = useState(false);
  const [previewTick, setPreviewTick] = useState(0);
  const h = cam.health;

  return (
    <Panel>
      <div className="row" style={{ marginBottom: 8 }}>
        <strong>{cam.name}</strong>
        <StatusBadge state={h?.state ?? "unknown"} />
        <span className="badge gray">{cam.source_type}</span>
        {cam.role.map((r) => (
          <span key={r} className="badge blue">{r}</span>
        ))}
      </div>
      <table className="small">
        <tbody>
          <tr><td className="dim">Last frame</td><td>{fmtDateTime(h?.last_frame_at)}</td></tr>
          <tr><td className="dim">Processing FPS</td><td>{h?.processing_fps ?? "–"}</td></tr>
          <tr><td className="dim">Latency</td><td>{h ? `${h.processing_latency_ms} ms` : "–"}</td></tr>
          <tr><td className="dim">Frames (recv / processed)</td>
            <td>{h ? `${h.frames_received} / ${h.frames_processed}` : "–"}</td></tr>
          <tr><td className="dim">Decode errors</td><td>{h?.decode_errors ?? "–"}</td></tr>
          <tr><td className="dim">Reconnect attempts</td><td>{h?.reconnect_attempts ?? "–"}</td></tr>
          {h?.last_error && (
            <tr><td className="dim">Last error</td><td style={{ color: "#f85149" }}>{h.last_error}</td></tr>
          )}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 10 }}>
        <button onClick={() => { setShowPreview(!showPreview); setPreviewTick(Date.now()); }}>
          {showPreview ? "Hide preview" : "Diagnostic preview"}
        </button>
        {showPreview && (
          <button onClick={() => setPreviewTick(Date.now())}>Refresh frame</button>
        )}
      </div>
      {showPreview && (
        <img
          src={`/api/cameras/${cam.camera_id}/snapshot?t=${previewTick}`}
          alt={`${cam.name} snapshot`}
          style={{ width: "100%", marginTop: 10, borderRadius: 8 }}
          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
        />
      )}
    </Panel>
  );
}

export default function Cameras() {
  const { data, error, reload } = usePolling(() => api.cameras(), 5000);
  const [reloadMsg, setReloadMsg] = useState<string | null>(null);

  const doReload = async () => {
    try {
      const r = await api.reloadCameras();
      setReloadMsg(
        `Reloaded. started: [${r.started}] stopped: [${r.stopped}] hot-reloaded: [${r.reloaded}]`
      );
      reload();
    } catch (e) {
      setReloadMsg(String(e));
    }
  };

  return (
    <>
      <div className="row">
        <h1>Cameras</h1>
        <div className="spacer" />
        <button className="primary" onClick={doReload}>Reload configuration</button>
      </div>
      {reloadMsg && <p className="dim small">{reloadMsg}</p>}
      <ErrorBox error={error} />
      <div className="grid card-grid">
        {(data ?? []).map((cam) => (
          <CameraCard key={cam.camera_id} cam={cam} />
        ))}
      </div>
    </>
  );
}
