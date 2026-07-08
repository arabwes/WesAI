import { useEffect, useRef, useState } from "react";
import { Camera, LineCfg, ZoneCfg, api } from "../api";
import { ErrorBox, Panel } from "../components";

type Mode = "select" | "add-line" | "add-zone" | "add-ignore";
type ShapeRef = { kind: "line" | "zone" | "ignore"; index: number } | null;

const ZONE_TYPES = [
  "entrance", "transition", "queue", "order", "pickup",
  "seating", "exit", "staff_only",
];

const ZONE_COLORS: Record<string, string> = {
  entrance: "#4fb3ff", transition: "#8b98a5", queue: "#d29922",
  order: "#bc8cff", pickup: "#3fb950", seating: "#58d0c8",
  exit: "#f85149", staff_only: "#e3b341", ignore: "#f85149",
};

let idCounter = 1;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${idCounter++}`;

export default function Calibration() {
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [camId, setCamId] = useState<string>("");
  const [frameTick, setFrameTick] = useState(Date.now());
  const [frameError, setFrameError] = useState<string | null>(null);
  const [natural, setNatural] = useState<[number, number]>([960, 540]);

  const [lines, setLines] = useState<LineCfg[]>([]);
  const [zones, setZones] = useState<ZoneCfg[]>([]);
  const [ignoreZones, setIgnoreZones] = useState<ZoneCfg[]>([]);
  const [mode, setMode] = useState<Mode>("select");
  const [draft, setDraft] = useState<number[][]>([]);
  const [selected, setSelected] = useState<ShapeRef>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const dragRef = useRef<{ shape: ShapeRef; point: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.cameras().then((cams) => {
      setCameras(cams);
      if (cams.length && !camId) setCamId(cams[0].camera_id);
    }).catch((e) => setFrameError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const cam = cameras.find((c) => c.camera_id === camId);
    if (!cam) return;
    setLines(cam.lines.map((l) => ({ ...l, points: l.points.map((p) => [...p]) })));
    setZones(cam.zones.map((z) => ({ ...z, points: z.points.map((p) => [...p]) })));
    setIgnoreZones(cam.ignore_zones.map((z) => ({ ...z, points: z.points.map((p) => [...p]) })));
    setSelected(null);
    setDraft([]);
    setSaveMsg(null);
    setFrameTick(Date.now());
  }, [camId, cameras]);

  // ---- coordinate mapping: displayed px -> native frame px ----
  const toFrameCoords = (e: React.MouseEvent): [number, number] => {
    const rect = stageRef.current!.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * natural[0];
    const y = ((e.clientY - rect.top) / rect.height) * natural[1];
    return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
  };

  const handleStageClick = (e: React.MouseEvent) => {
    if (mode === "select") return;
    const p = toFrameCoords(e);
    if (mode === "add-line") {
      const next = [...draft, p];
      if (next.length === 2) {
        setLines([...lines, {
          line_id: newId("line"), name: "New line", points: next, direction_in: "down",
        }]);
        setDraft([]);
        setMode("select");
        setSelected({ kind: "line", index: lines.length });
      } else {
        setDraft(next);
      }
    } else {
      setDraft([...draft, p]);
    }
  };

  const finishPolygon = () => {
    if (draft.length < 3) return;
    if (mode === "add-zone") {
      setZones([...zones, { zone_id: newId("zone"), name: "New zone", type: "transition", points: draft }]);
      setSelected({ kind: "zone", index: zones.length });
    } else if (mode === "add-ignore") {
      setIgnoreZones([...ignoreZones, { zone_id: newId("ignore"), name: "Ignore area", type: "ignore", points: draft }]);
      setSelected({ kind: "ignore", index: ignoreZones.length });
    }
    setDraft([]);
    setMode("select");
  };

  // ---- point dragging ----
  const startDrag = (shape: ShapeRef, point: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    dragRef.current = { shape, point };
    setSelected(shape);
  };
  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !drag.shape) return;
    const p = toFrameCoords(e as unknown as React.MouseEvent);
    const { kind, index } = drag.shape;
    const update = (arr: any[], setter: (v: any[]) => void) => {
      const copy = arr.map((s) => ({ ...s, points: s.points.map((q: number[]) => [...q]) }));
      copy[index].points[drag.point] = p;
      setter(copy);
    };
    if (kind === "line") update(lines, setLines);
    else if (kind === "zone") update(zones, setZones);
    else update(ignoreZones, setIgnoreZones);
  };
  const endDrag = () => { dragRef.current = null; };

  // ---- selected shape editing ----
  const sel =
    selected?.kind === "line" ? lines[selected.index]
    : selected?.kind === "zone" ? zones[selected.index]
    : selected?.kind === "ignore" ? ignoreZones[selected.index]
    : null;

  const updateSelected = (patch: Record<string, unknown>) => {
    if (!selected) return;
    const apply = (arr: any[], setter: (v: any[]) => void) => {
      const copy = [...arr];
      copy[selected.index] = { ...copy[selected.index], ...patch };
      setter(copy);
    };
    if (selected.kind === "line") apply(lines, setLines);
    else if (selected.kind === "zone") apply(zones, setZones);
    else apply(ignoreZones, setIgnoreZones);
  };

  const deleteSelected = () => {
    if (!selected) return;
    if (selected.kind === "line") setLines(lines.filter((_, i) => i !== selected.index));
    else if (selected.kind === "zone") setZones(zones.filter((_, i) => i !== selected.index));
    else setIgnoreZones(ignoreZones.filter((_, i) => i !== selected.index));
    setSelected(null);
  };

  const save = async () => {
    try {
      const r = await api.saveCalibration(camId, { lines, zones, ignore_zones: ignoreZones });
      setSaveMsg(`Saved (worker ${r.worker_reloaded ? "hot-reloaded" : "not running"}) → ${r.saved_to}`);
    } catch (e) {
      setSaveMsg(String(e));
    }
  };

  const scaleStroke = natural[0] / 960; // keep stroke widths readable

  return (
    <>
      <h1>Calibration</h1>
      <p className="dim small">
        Draw crossing lines and zones directly on a captured frame. Changes are
        saved to cameras.yaml and hot-reloaded into the running camera worker.
      </p>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={camId} onChange={(e) => setCamId(e.target.value)}>
          {cameras.map((c) => (
            <option key={c.camera_id} value={c.camera_id}>{c.name}</option>
          ))}
        </select>
        <button onClick={() => { setFrameTick(Date.now()); setFrameError(null); }}>
          Capture new frame
        </button>
        <div className="spacer" />
        <button className={mode === "add-line" ? "primary" : ""}
          onClick={() => { setMode(mode === "add-line" ? "select" : "add-line"); setDraft([]); }}>
          + Line
        </button>
        <button className={mode === "add-zone" ? "primary" : ""}
          onClick={() => { setMode(mode === "add-zone" ? "select" : "add-zone"); setDraft([]); }}>
          + Zone
        </button>
        <button className={mode === "add-ignore" ? "primary" : ""}
          onClick={() => { setMode(mode === "add-ignore" ? "select" : "add-ignore"); setDraft([]); }}>
          + Ignore area
        </button>
        {(mode === "add-zone" || mode === "add-ignore") && draft.length >= 3 && (
          <button className="primary" onClick={finishPolygon}>Finish polygon</button>
        )}
        <button className="primary" onClick={save}>Save & reload</button>
      </div>
      {mode !== "select" && (
        <p className="small" style={{ color: "#4fb3ff" }}>
          {mode === "add-line"
            ? `Click two points to place the line (${draft.length}/2)`
            : `Click to add polygon points (${draft.length}) — then Finish polygon`}
        </p>
      )}
      {saveMsg && <p className="dim small">{saveMsg}</p>}
      <ErrorBox error={frameError} />

      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr", alignItems: "start" }}>
        <div
          className="calib-stage panel"
          ref={stageRef}
          style={{ padding: 0, cursor: mode === "select" ? "default" : "crosshair" }}
          onClick={handleStageClick}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerLeave={endDrag}
        >
          {camId && <img
            src={`/api/calibration/${camId}/frame?t=${frameTick}`}
            alt="camera frame"
            onLoad={(e) => {
              const img = e.target as HTMLImageElement;
              setNatural([img.naturalWidth, img.naturalHeight]);
              setFrameError(null);
            }}
            onError={() => setFrameError("No frame available — the camera must be online.")}
          />}
          <svg viewBox={`0 0 ${natural[0]} ${natural[1]}`} preserveAspectRatio="none">
            {/* zones */}
            {[...zones.map((z, i) => ({ z, i, kind: "zone" as const })),
              ...ignoreZones.map((z, i) => ({ z, i, kind: "ignore" as const }))].map(({ z, i, kind }) => {
              const color = ZONE_COLORS[kind === "ignore" ? "ignore" : z.type] ?? "#8b98a5";
              const isSel = selected?.kind === kind && selected.index === i;
              return (
                <g key={`${kind}-${i}`}>
                  <polygon
                    points={z.points.map((p) => p.join(",")).join(" ")}
                    fill={color} fillOpacity={isSel ? 0.35 : 0.18}
                    stroke={color} strokeWidth={2 * scaleStroke}
                    strokeDasharray={kind === "ignore" ? `${6 * scaleStroke},${5 * scaleStroke}` : undefined}
                    style={{ cursor: "pointer" }}
                    onClick={(e) => { e.stopPropagation(); if (mode === "select") setSelected({ kind, index: i }); }}
                  />
                  {z.points[0] && (
                    <text x={z.points[0][0]} y={z.points[0][1] - 6 * scaleStroke}
                      fill={color} fontSize={13 * scaleStroke} fontWeight={700}>
                      {z.name || z.zone_id}
                    </text>
                  )}
                  {isSel && z.points.map((p, pi) => (
                    <circle key={pi} cx={p[0]} cy={p[1]} r={6 * scaleStroke}
                      fill={color} stroke="#fff" strokeWidth={1.5 * scaleStroke}
                      style={{ cursor: "grab" }}
                      onPointerDown={startDrag({ kind, index: i }, pi)} />
                  ))}
                </g>
              );
            })}
            {/* lines */}
            {lines.map((l, i) => {
              const isSel = selected?.kind === "line" && selected.index === i;
              if (l.points.length !== 2) return null;
              const [a, b] = l.points;
              const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
              const arrow = { up: "↑ in", down: "↓ in", left: "← in", right: "→ in" }[l.direction_in];
              return (
                <g key={`line-${i}`}>
                  <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]}
                    stroke="#f85149" strokeWidth={(isSel ? 4 : 3) * scaleStroke}
                    style={{ cursor: "pointer" }}
                    onClick={(e) => { e.stopPropagation(); if (mode === "select") setSelected({ kind: "line", index: i }); }} />
                  <text x={mid[0] + 8 * scaleStroke} y={mid[1] - 8 * scaleStroke}
                    fill="#f85149" fontSize={13 * scaleStroke} fontWeight={700}>
                    {(l.name || l.line_id)} {arrow}
                  </text>
                  {isSel && l.points.map((p, pi) => (
                    <circle key={pi} cx={p[0]} cy={p[1]} r={7 * scaleStroke}
                      fill="#f85149" stroke="#fff" strokeWidth={1.5 * scaleStroke}
                      style={{ cursor: "grab" }}
                      onPointerDown={startDrag({ kind: "line", index: i }, pi)} />
                  ))}
                </g>
              );
            })}
            {/* draft shape being drawn */}
            {draft.length > 0 && (
              <g>
                {mode === "add-line" ? (
                  <circle cx={draft[0][0]} cy={draft[0][1]} r={6 * scaleStroke} fill="#4fb3ff" />
                ) : (
                  <polygon points={draft.map((p) => p.join(",")).join(" ")}
                    fill="#4fb3ff" fillOpacity={0.2} stroke="#4fb3ff" strokeWidth={2 * scaleStroke} />
                )}
                {draft.map((p, pi) => (
                  <circle key={pi} cx={p[0]} cy={p[1]} r={5 * scaleStroke} fill="#4fb3ff" />
                ))}
              </g>
            )}
          </svg>
        </div>

        <div>
          {sel ? (
            <Panel title={selected?.kind === "line" ? "Line properties" : "Zone properties"}>
              <div className="grid" style={{ gap: 10 }}>
                <label className="small dim">
                  Name<br />
                  <input type="text" style={{ width: "100%", marginTop: 4 }}
                    value={(sel as any).name ?? ""}
                    onChange={(e) => updateSelected({ name: e.target.value })} />
                </label>
                {selected?.kind === "line" && (
                  <div>
                    <div className="small dim" style={{ marginBottom: 6 }}>
                      Inward direction (which way is INTO the store?)
                    </div>
                    <div className="row">
                      {(["up", "down", "left", "right"] as const).map((d) => (
                        <button key={d}
                          className={(sel as LineCfg).direction_in === d ? "primary" : ""}
                          onClick={() => updateSelected({ direction_in: d })}>
                          {{ up: "↑ up", down: "↓ down", left: "← left", right: "→ right" }[d]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {selected?.kind === "zone" && (
                  <label className="small dim">
                    Zone type<br />
                    <select style={{ marginTop: 4 }} value={(sel as ZoneCfg).type}
                      onChange={(e) => updateSelected({ type: e.target.value })}>
                      {ZONE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </label>
                )}
                <div className="row">
                  <button className="danger" onClick={deleteSelected}>Delete</button>
                  <button onClick={() => setSelected(null)}>Deselect</button>
                </div>
              </div>
            </Panel>
          ) : (
            <Panel title="How to calibrate">
              <ol className="small dim" style={{ paddingLeft: 18, lineHeight: 1.7 }}>
                <li>Pick a camera and capture a frame.</li>
                <li><strong>+ Line</strong>: click two points across the doorway, then set the inward direction.</li>
                <li><strong>+ Zone</strong>: click the corners of an area (queue, seating…), then Finish polygon.</li>
                <li><strong>+ Ignore area</strong>: mask exterior areas like sidewalks.</li>
                <li>Click any shape to rename, retype, or drag its points.</li>
                <li><strong>Save &amp; reload</strong> applies changes to the live pipeline immediately.</li>
              </ol>
            </Panel>
          )}
          <div style={{ marginTop: 14 }}>
            <Panel title="Shapes on this camera">
              <table className="small">
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={`l${i}`} className="clickable" onClick={() => setSelected({ kind: "line", index: i })}>
                      <td><span className="badge red">line</span></td>
                      <td>{l.name || l.line_id}</td><td className="dim">in: {l.direction_in}</td>
                    </tr>
                  ))}
                  {zones.map((z, i) => (
                    <tr key={`z${i}`} className="clickable" onClick={() => setSelected({ kind: "zone", index: i })}>
                      <td><span className="badge blue">zone</span></td>
                      <td>{z.name || z.zone_id}</td><td className="dim">{z.type}</td>
                    </tr>
                  ))}
                  {ignoreZones.map((z, i) => (
                    <tr key={`i${i}`} className="clickable" onClick={() => setSelected({ kind: "ignore", index: i })}>
                      <td><span className="badge gray">ignore</span></td>
                      <td>{z.name || z.zone_id}</td><td />
                    </tr>
                  ))}
                  {lines.length + zones.length + ignoreZones.length === 0 && (
                    <tr><td className="dim">Nothing drawn yet.</td></tr>
                  )}
                </tbody>
              </table>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}
