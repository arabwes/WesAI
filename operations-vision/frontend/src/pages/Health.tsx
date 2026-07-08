import { api } from "../api";
import { ErrorBox, Panel, Stat, StatusBadge } from "../components";
import { usePolling } from "../hooks";

export default function Health() {
  const { data, error } = usePolling(() => api.systemStatus(), 5000);
  const { data: quality } = usePolling(() => api.quality(), 15000);

  return (
    <>
      <h1>System Health</h1>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="grid stat-grid">
            <Stat label="Backend" value={<StatusBadge state={data.backend} />} />
            <Stat label="Database" value={<StatusBadge state={data.database} />} />
            <Stat
              label="Pipeline"
              value={<StatusBadge state={data.pipeline_running ? "ok" : "offline"} />}
              sub={`${data.camera_workers_alive} worker(s) alive`}
            />
            <Stat label="Queue depth" value={data.queue_depth ?? "–"} />
            <Stat
              label="Appearance vectors held"
              value={data.appearance_vectors_held}
              sub="temporary, auto-expiring"
            />
            <Stat
              label="Disk free"
              value={`${data.disk.free_gb} GB`}
              sub={`of ${data.disk.total_gb} GB`}
            />
            {data.cpu_percent != null && <Stat label="CPU" value={`${data.cpu_percent}%`} />}
            {data.memory_percent != null && <Stat label="Memory" value={`${data.memory_percent}%`} />}
          </div>

          <div className="grid chart-grid">
            <Panel title="Camera workers">
              <table>
                <thead>
                  <tr>
                    <th>Camera</th><th>State</th><th>FPS</th><th>Latency</th>
                    <th>Decode errors</th><th>Reconnects</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(data.cameras).map(([id, h]) => (
                    <tr key={id}>
                      <td>{id}</td>
                      <td><StatusBadge state={h.state} /></td>
                      <td>{h.processing_fps}</td>
                      <td>{h.processing_latency_ms} ms</td>
                      <td>{h.decode_errors}</td>
                      <td>{h.reconnect_attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>

            {quality && (
              <Panel title="Tracking quality — today">
                <table>
                  <tbody>
                    <tr><td className="dim">Visits</td><td>{quality.visits_total}</td></tr>
                    <tr><td className="dim">High-confidence completed</td><td>{quality.high_confidence_visits}</td></tr>
                    <tr><td className="dim">Moderate-confidence completed</td><td>{quality.moderate_confidence_visits}</td></tr>
                    <tr><td className="dim">Uncertain</td><td>{quality.uncertain_visits}</td></tr>
                    <tr><td className="dim">Lost</td><td>{quality.lost_visits}</td></tr>
                    <tr><td className="dim">Handoffs</td><td>{quality.handoffs}</td></tr>
                    <tr><td className="dim">Avg handoff confidence</td>
                      <td>{quality.avg_handoff_confidence != null
                        ? `${Math.round(quality.avg_handoff_confidence * 100)}%` : "–"}</td></tr>
                    <tr><td className="dim">Handoff acceptance (session)</td>
                      <td>{quality.session_handoff_acceptance_rate != null
                        ? `${Math.round(quality.session_handoff_acceptance_rate * 100)}%` : "–"}</td></tr>
                  </tbody>
                </table>
              </Panel>
            )}
          </div>
        </>
      )}
    </>
  );
}
