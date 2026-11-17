import type { PaperMode, RevealStyle } from "../render/draw";
import type { Animation, RevealSpeed } from "../lesson/reveal";
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
            <Seg value={s.stylus} options={[["auto", "After first pen use"], ["always", "Always"], ["never", "Never"]]} onChange={(v) => set({ stylus: v })} />
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
            <Seg<RevealStyle>
              value={p.animation.style}
              options={[["write", "Write"], ["fade", "Fade"], ["wipe", "Wipe"], ["instant", "Instant"]]}
              onChange={(style) => p.onAnimation!({ ...p.animation!, style })}
            />
          </div>
          {p.animation.style !== "instant" && (
            <div className="row">
              <span>Reveal speed</span>
              <Seg<RevealSpeed>
                value={p.animation.speed}
                options={[["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]]}
                onChange={(speed) => p.onAnimation!({ ...p.animation!, speed })}
              />
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

      <details>
        <summary>Shortcuts</summary>
        {p.scope === "edit" ? (
          <p className="muted small">
            0–9 pick step · N new step · ← → previous/next step · F fit · L lock zoom · ⌘/Ctrl+Z undo · ⌘/Ctrl+S save · P present
          </p>
        ) : (
          <p className="muted small">
            → / Space next · ← back · A all · R restart · O whole canvas · + − zoom · L lock zoom · F full screen · Esc exit.
            A stylus always draws the laser; fingers tap to advance.
          </p>
        )}
      </details>
    </div>
  );
}
