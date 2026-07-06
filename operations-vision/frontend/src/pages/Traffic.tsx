import { useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Legend,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { api } from "../api";
import { CHART_COLORS as C, ErrorBox, Panel, Stat } from "../components";
import { usePolling } from "../hooks";

function rangeParams(days: number): string {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - (days - 1));
  const d = (x: Date) => x.toISOString().slice(0, 10);
  return `?start=${d(start)}&end=${d(end)}`;
}

export default function Traffic() {
  const [days, setDays] = useState(1);
  const { data, error } = usePolling(() => api.traffic(rangeParams(days)), 15000);

  return (
    <>
      <h1>Traffic</h1>
      <div className="row" style={{ marginBottom: 14 }}>
        {[1, 7, 30].map((d) => (
          <button
            key={d}
            className={days === d ? "primary" : ""}
            onClick={() => setDays(d)}
          >
            {d === 1 ? "Today" : `Last ${d} days`}
          </button>
        ))}
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <div className="grid stat-grid">
            <Stat label="Entries" value={data.entries} />
            <Stat label="Exits" value={data.exits} />
            <Stat label="Busiest hour" value={data.busiest_hour ? data.busiest_hour.slice(11) : "–"} />
          </div>
          <div className="grid chart-grid">
            <Panel title="Hourly entries / exits">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={data.by_hour}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="hour" tickFormatter={(h: string) => h.slice(5)} stroke={C.text} fontSize={11} />
                  <YAxis allowDecimals={false} stroke={C.text} fontSize={11} />
                  <Tooltip contentStyle={{ background: "#1d2630", border: "1px solid #2a3542" }} />
                  <Legend />
                  <Bar dataKey="entries" fill={C.entries} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="exits" fill={C.exits} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
            <Panel title="Daily totals">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={data.by_day}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis dataKey="day" stroke={C.text} fontSize={11} />
                  <YAxis allowDecimals={false} stroke={C.text} fontSize={11} />
                  <Tooltip contentStyle={{ background: "#1d2630", border: "1px solid #2a3542" }} />
                  <Legend />
                  <Bar dataKey="entries" fill={C.entries} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="exits" fill={C.exits} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
