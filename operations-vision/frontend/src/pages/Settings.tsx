import { api } from "../api";
import { ErrorBox, Panel } from "../components";
import { usePolling } from "../hooks";

export default function Settings() {
  const { data: topo, error } = usePolling(() => api.topology(), 60000);
  const { data: status } = usePolling(() => api.systemStatus(), 30000);

  return (
    <>
      <h1>Settings</h1>
      <ErrorBox error={error} />
      <div className="grid card-grid">
        <Panel title="Camera topology (from topology.yaml)">
          <p className="dim small">
            Defines which camera-to-camera walks are physically possible and how
            long they take. Edit config/topology.yaml and restart (or POST
            /api/cameras/reload) to change.
          </p>
          <table className="small">
            <thead>
              <tr><th>From</th><th>To</th><th>Min</th><th>Expected</th><th>Max</th></tr>
            </thead>
            <tbody>
              {(topo?.transitions ?? []).map((t, i) => (
                <tr key={i}>
                  <td>{t.from}</td>
                  <td>{t.to}</td>
                  <td>{t.min_seconds}s</td>
                  <td>{t.expected_seconds}s</td>
                  <td>{t.max_seconds}s</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>

        <Panel title="Privacy model">
          <ul className="small dim" style={{ lineHeight: 1.8, paddingLeft: 18 }}>
            <li>Customers are <strong>anonymous</strong> — no identity data is ever collected.</li>
            <li><strong>No facial recognition</strong>, no face crops, no face embeddings.</li>
            <li>Visits are temporary journeys; matching uses timing, store layout,
              and clothing-level color only.</li>
            <li>Appearance features live in memory and auto-expire
              ({status ? `${status.appearance_vectors_held} currently held` : "…"}).</li>
            <li>No cross-day recognition: a returning customer is a brand-new visit.</li>
            <li>The database stores events and aggregates — never imagery.</li>
          </ul>
        </Panel>

        <Panel title="Configuration files">
          <table className="small">
            <tbody>
              <tr><td className="dim">App settings</td><td>config/app.yaml</td></tr>
              <tr><td className="dim">Cameras, lines, zones</td><td>config/cameras.yaml (editable via Calibration page)</td></tr>
              <tr><td className="dim">Topology</td><td>config/topology.yaml</td></tr>
              <tr><td className="dim">RTSP credentials</td><td>.env (never committed)</td></tr>
              <tr><td className="dim">Matching thresholds</td><td>config/app.yaml → matching</td></tr>
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
