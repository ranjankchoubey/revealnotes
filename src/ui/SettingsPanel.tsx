import type { PaperMode, RevealStyle } from "../render/draw";
import { REVEAL_STYLES, type Animation } from "../lesson/reveal";

const STYLE_INFO: Record<RevealStyle, [string, string]> = {
  write: ["Write", "Strokes draw themselves in the order you wrote them (recommended)"],
  fade: ["Fade", "The step fades in"],
  rise: ["Rise", "Strokes float up into place, one after another"],
  pop: ["Pop", "Strokes pop in with a little bounce, one after another"],
  wipe: ["Wipe", "Uncovered left to right"],
  roll: ["Roll down", "Uncovered top to bottom"],
  instant: ["Instant", "Appears at once"],
};
import { IconButton } from "./icons";
import { LASER_COLORS, setSettings, useSettings, type Settings } from "./settings";

interface Props {
  scope: "edit" | "present";
  onClose: () => void;
  paper?: PaperMode;
  onPaper?: (p: PaperMode) => void;
  onLoadSteps?: () => void;
  onExport?: () => void;
  animation?: Animation;
  onAnimation?: (a: Animation) => void;
}

function Seg<T extends string | number>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={String(v)} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{label}</button>
      ))}
    </div>
  );
}

export function SettingsPanel(p: Props) {
  const s = useSettings();
  const set = (patch: Partial<Settings>) => setSettings(patch);
  return (
    <div className="settings" onPointerDown={(e) => e.stopPropagation()}>
      <header>
        <b>Settings</b>
        <IconButton icon="close" onClick={p.onClose} title="Close" />
      </header>

      {p.paper && p.onPaper && (
        <div className="row">
          <span>Theme</span>
          <Seg<PaperMode> value={p.paper} options={[["light", "Light"], ["dark", "Dark"]]} onChange={p.onPaper} />
        </div>
      )}

      {p.scope === "edit" && (
        <>
          <div className="row">
            <span>Select with</span>
            <Seg value={s.selectTool} options={[["lasso", "Lasso"], ["box", "Box"]]} onChange={(v) => set({ selectTool: v })} />
          </div>
          <div className="row col">
            <span>Stylus: pen selects, fingers pan</span>
            <Seg value={s.stylus} options={[["auto", "Once a pen is used here"], ["always", "Always"], ["never", "Never"]]} onChange={(v) => set({ stylus: v })} />
          </div>
          <div className="row">
            <span>Step numbers on strokes</span>
            <Seg value={s.badges ? "on" : "off"} options={[["on", "Show"], ["off", "Hide"]]} onChange={(v) => set({ badges: v === "on" })} />
          </div>
        </>
      )}

      {p.animation && p.onAnimation && (
        <>
          <div className="row col">
            <span>Reveal style</span>
            <div className="styles">
              {REVEAL_STYLES.map((st) => (
                <button
                  key={st}
                  className={st === p.animation!.style ? "on" : ""}
                  onClick={() => p.onAnimation!({ ...p.animation!, style: st })}
                  title={STYLE_INFO[st][1]}
                >
                  {STYLE_INFO[st][0]}
                </button>
              ))}
            </div>
            <small className="muted">{STYLE_INFO[p.animation.style][1]}</small>
          </div>
          {p.animation.style !== "instant" && (
            <div className="row">
              <span>Speed</span>
              <div className="speed">
                <input
                  type="range"
                  min={0.25}
                  max={3}
                  step={0.25}
                  value={p.animation.speed}
                  onChange={(e) => p.onAnimation!({ ...p.animation!, speed: Number(e.target.value) })}
                />
                <span>{p.animation.speed}×</span>
              </div>
            </div>
          )}
        </>
      )}

      <div className="row">
        <span title="On big canvases, zoom and scroll to each new step">Camera follows steps</span>
        <Seg value={s.cameraFollow ? "on" : "off"} options={[["on", "On"], ["off", "Off"]]} onChange={(v) => set({ cameraFollow: v === "on" })} />
      </div>
      <div className="row">
        <span>Laser fades after</span>
        <Seg value={s.laserSeconds} options={[[1, "1s"], [2, "2s"], [3, "3s"], [5, "5s"]]} onChange={(v) => set({ laserSeconds: v })} />
      </div>
      <div className="row">
        <span>Laser colour</span>
        <div className="swatches">
          {LASER_COLORS.map((c) => (
            <button key={c} className={c === s.laserColor ? "on" : ""} style={{ background: c }} onClick={() => set({ laserColor: c })} aria-label={c} />
          ))}
        </div>
      </div>

      {(p.onLoadSteps || p.onExport) && (
        <div className="row actions">
          {p.onLoadSteps && <IconButton icon="upload" label="Load steps file" onClick={p.onLoadSteps} />}
          {p.onExport && <IconButton icon="export" label="Export HTML" onClick={p.onExport} />}
        </div>
      )}
      {p.onExport && (
        <div className="row">
          <span title="The exported file starts with your camera-follow and laser settings; viewers can still change them">
            Export with these presenter settings
          </span>
          <Seg value={s.embedPresenter ? "on" : "off"} options={[["on", "On"], ["off", "Off"]]} onChange={(v) => set({ embedPresenter: v === "on" })} />
        </div>
      )}

      <details>
        <summary>Shortcuts</summary>
        {p.scope === "edit" ? (
          <p className="muted small">
            0–9 pick step · N new step · ← → previous/next step · F fit · L lock zoom · ⌘/Ctrl+Z undo · ⌘/Ctrl+S save · P present
          </p>
        ) : (
          <p className="muted small">
            → / Space next · ← back · A all · R restart · W fit width · H fit height · O whole canvas · + − zoom · L lock zoom · F full screen · Esc exit.
            P laser · D pen · M highlighter · C clear writing · ⌘/Ctrl+Z undo writing · K pause recording.
            A stylus draws with the chosen tool (laser by default); fingers tap to advance and drag to scroll.
          </p>
        )}
      </details>
    </div>
  );
}
