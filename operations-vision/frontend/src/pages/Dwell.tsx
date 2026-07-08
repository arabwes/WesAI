import {
  Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api, fmtDwell } from "../api";
import { CHART_COLORS as C, ErrorBox, Panel, Stat } from "../components";
import { usePolling } from "../hooks";

export default function Dwell() {
  const { data, error } = usePolling(() => api.dwell(), 15000);

  return (
    <>
      <h1>Dwell Time — Today</h1>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="grid stat-grid">
            <Stat
              label="Average dwell (high confidence)"
              value={fmtDwell(data.high_confidence.avg_seconds)}
              sub={`${data.high_confidence.count} visits`}
            />
            <Stat
              label="Average dwell (all completed)"
              value={fmtDwell(data.all_completed.avg_seconds)}
              sub={`${data.all_completed.count} visits`}
            />
            <Stat label="Median dwell" value={fmtDwell(data.all_completed.median_seconds)} />
            <Stat label="90th percentile" value={fmtDwell(data.all_completed.p90_seconds)} />
            <Stat label="Lost visits" value={data.lost_count} sub="tracking lost before exit" />
            <Stat label="Uncertain visits" value={data.uncertain_count} />
          </div>

          <div className="grid chart-grid">
            <Panel title="Dwell distribution">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data.buckets}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="bucket" stroke={C.text} fontSize={11} />
                  <YAxis allowDecimals={false} stroke={C.text} fontSize={11} />
                  <Tooltip contentStyle={{ background: "#1d2630", border: "1px solid #2a3542" }} />
                  <Bar dataKey="count" fill={C.dwell} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            <Panel title="Average dwell by hour of entry (seconds)">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data.by_hour_of_entry}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="hour" stroke={C.text} fontSize={11} />
                  <YAxis stroke={C.text} fontSize={11} />
                  <Tooltip contentStyle={{ background: "#1d2630", border: "1px solid #2a3542" }} />
                  <Bar dataKey="avg_seconds" fill={C.entries} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>

          <Panel title="Percentiles (all completed visits)" className="chart-grid">
            <table>
              <thead>
                <tr><th>p25</th><th>Median</th><th>p75</th><th>p90</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td>{fmtDwell(data.all_completed.p25_seconds)}</td>
                  <td>{fmtDwell(data.all_completed.median_seconds)}</td>
                  <td>{fmtDwell(data.all_completed.p75_seconds)}</td>
                  <td>{fmtDwell(data.all_completed.p90_seconds)}</td>
                </tr>
              </tbody>
            </table>
          </Panel>
        </>
      )}
    </>
  );
}
