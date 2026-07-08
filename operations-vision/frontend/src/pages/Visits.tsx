import { useState } from "react";
import { Visit, api, fmtDwell, fmtTime } from "../api";
import { ErrorBox, Panel, StatusBadge } from "../components";
import { usePolling } from "../hooks";

function VisitDetail({ visitId, onClose }: { visitId: string; onClose: () => void }) {
  const { data } = usePolling(() => api.visit(visitId), 60000);
  if (!data) return null;
  return (
    <Panel title={`Visit ${data.visit_id}`}>
      <div className="row" style={{ marginBottom: 10 }}>
        <StatusBadge state={data.status} />
        {data.is_demo && <span className="badge yellow">demo</span>}
        <span className="dim small">
          entered {fmtTime(data.entry_time)} · exited {fmtTime(data.exit_time)} · dwell{" "}
          {fmtDwell(data.dwell_seconds)} · confidence {Math.round(data.match_confidence * 100)}% ·{" "}
          {data.cameras_observed} camera(s), {data.handoff_count} handoff(s)
        </span>
        <div className="spacer" />
        <button onClick={onClose}>Close</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Camera</th><th>Track</th><th>First seen</th><th>Last seen</th><th>Zone</th><th>Confidence</th>
          </tr>
        </thead>
        <tbody>
          {data.observations?.map((o, i) => (
            <tr key={i}>
              <td>{o.camera_id}</td>
              <td className="dim">{o.camera_track_id}</td>
              <td>{fmtTime(o.first_seen)}</td>
              <td>{fmtTime(o.last_seen)}</td>
              <td>{o.zone ?? "–"}</td>
              <td>{Math.round(o.confidence * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export default function Visits() {
  const [status, setStatus] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error } = usePolling(
    () => api.visits(status ? `?status=${status}` : ""),
    10000
  );

  return (
    <>
      <h1>Visits — Today</h1>
      <p className="dim small">
        Visits are anonymous. No names exist — each row is a temporary in-store
        journey identified only by an opaque visit ID.
      </p>
      <div className="row" style={{ marginBottom: 14 }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
          <option value="uncertain">Uncertain</option>
          <option value="lost">Lost</option>
        </select>
      </div>
      <ErrorBox error={error} />
      {selected && (
        <div style={{ marginBottom: 14 }}>
          <VisitDetail visitId={selected} onClose={() => setSelected(null)} />
        </div>
      )}
      <Panel>
        <table>
          <thead>
            <tr>
              <th>Visit</th><th>Status</th><th>Entered</th><th>Exited</th>
              <th>Dwell</th><th>Cameras</th><th>Handoffs</th><th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {(data?.visits ?? []).map((v: Visit) => (
              <tr key={v.visit_id} className="clickable" onClick={() => setSelected(v.visit_id)}>
                <td>
                  {v.visit_id} {v.is_demo && <span className="badge yellow">demo</span>}
                </td>
                <td><StatusBadge state={v.status} /></td>
                <td>{fmtTime(v.entry_time)}</td>
                <td>{fmtTime(v.exit_time)}</td>
                <td>{fmtDwell(v.dwell_seconds)}</td>
                <td>{v.cameras_observed}</td>
                <td>{v.handoff_count}</td>
                <td>{Math.round(v.match_confidence * 100)}%</td>
              </tr>
            ))}
            {data && data.visits.length === 0 && (
              <tr><td colSpan={8} className="dim">No visits yet for this filter.</td></tr>
            )}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
