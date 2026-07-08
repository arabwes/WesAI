import {
  Bar, BarChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api, fmtDwell } from "../api";
import { CHART_COLORS as C, ErrorBox, Panel, Stat } from "../components";
import { usePolling } from "../hooks";

const hourLabel = (h: string) => h.slice(11);
const timeLabel = (t: string) => t.slice(11);

export default function Overview() {
  const { data, error } = usePolling(() => api.overview(), 10000);

  return (
    <>
      <h1>Overview — Today</h1>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="grid stat-grid">
            <Stat label="Customers today" value={data.customers_today} />
            <Stat label="Current occupancy" value={data.current_occupancy} />
            <Stat
              label="Peak occupancy"
              value={data.peak_occupancy}
              sub={data.peak_at ? `at ${timeLabel(data.peak_at)}` : undefined}
            />
            <Stat label="Average dwell" value={fmtDwell(data.avg_dwell_seconds)} />
            <Stat
              label="Tracking quality"
              value={data.completion_rate != null ? `${Math.round(data.completion_rate * 100)}%` : "–"}
              sub="visits completed"
            />
            <Stat
              label="Cameras online"
              value={`${data.cameras_online}/${data.cameras_total}`}
            />
          </div>

          <div className="grid chart-grid">
            <Panel title="Visitors by hour">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.visitors_by_hour}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="hour" tickFormatter={hourLabel} stroke={C.text} fontSize={11} />
                  <YAxis allowDecimals={false} stroke={C.text} fontSize={11} />
                  <Tooltip contentStyle={{ background: "#1d2630", border: "1px solid #2a3542" }} />
                  <Bar dataKey="entries" fill={C.entries} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="exits" fill={C.exits} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>

            <Panel title="Occupancy timeline">
              <ResponsiveContainer width="100%" height={240}>
                <LineChart data={data.occupancy_timeline}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="time" tickFormatter={timeLabel} stroke={C.text} fontSize={11} />
                  <YAxis allowDecimals={false} stroke={C.text} fontSize={11} />
                  <Tooltip contentStyle={{ background: "#1d2630", border: "1px solid #2a3542" }} />
                  <Line type="stepAfter" dataKey="occupancy" stroke={C.occupancy} dot={false} strokeWidth={2} />
                </LineChart>
              </ResponsiveContainer>
            </Panel>

            <Panel title="Dwell distribution">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.dwell_buckets}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="bucket" stroke={C.text} fontSize={11} />
                  <YAxis allowDecimals={false} stroke={C.text} fontSize={11} />
                  <Tooltip contentStyle={{ background: "#1d2630", border: "1px solid #2a3542" }} />
                  <Bar dataKey="count" fill={C.dwell} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
