// Line icons: 24x24, 2px round stroke. Paths from XNotes' XnotesIcons (MIT, Shardul Vikram Singh),
// themselves Lucide/Feather-derived (ISC/MIT).
const circle = (cx: number, cy: number, r: number) => `M ${cx - r} ${cy} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
const rect = (x: number, y: number, w: number, h: number) => `M ${x} ${y} h ${w} v ${h} h ${-w} Z`;

const PATHS = {
  back: ["M15 18l-6-6 6-6"],
  prev: ["M15 18l-6-6 6-6"],
  next: ["M9 18l6-6-6-6"],
  undo: ["M9 14 4 9l5-5", "M20 20v-7a4 4 0 0 0-4-4H4"],
  zoomIn: [circle(11, 11, 8), "M21 21l-4.35-4.35", "M11 8v6", "M8 11h6"],
  zoomOut: [circle(11, 11, 8), "M21 21l-4.35-4.35", "M8 11h6"],
  fit: ["M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3"],
  lock: [rect(3, 11, 18, 11), "M7 11V7a5 5 0 0 1 10 0v4"],
  unlock: [rect(3, 11, 18, 11), "M7 11V7a5 5 0 0 1 9.9-1"],
  save: ["M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z", "M17 21v-8H7v8", "M7 3v5h8"],
  check: ["M20 6 9 17l-5-5"],
  export: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  play: ["M6 3l14 9-14 9Z"],
  plus: ["M12 5v14", "M5 12h14"],
  chevronDown: ["M6 9l6 6 6-6"],
  fullscreen: ["M15 3h6v6", "M9 21H3v-6", "M21 3l-7 7", "M3 21l7-7"],
  close: ["M18 6 6 18", "M6 6l12 12"],
  restart: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  revealAll: ["M13 17l5-5-5-5", "M6 17l5-5-5-5"],
  folder: ["M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2Z"],
  moon: ["M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"],
  sun: [circle(12, 12, 4), "M12 2v2", "M12 20v2", "M4.93 4.93l1.41 1.41", "M17.66 17.66l1.41 1.41", "M2 12h2", "M20 12h2", "M6.34 17.66l-1.41 1.41", "M19.07 4.93l-1.41 1.41"],
  steps: ["M8 6h13", "M8 12h13", "M8 18h13", "M3 6h.01", "M3 12h.01", "M3 18h.01"],
  trash: ["M3 6h18", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"],
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name].join(" ")} />
    </svg>
  );
}

interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  label?: string;
  active?: boolean;
}

/** Toolbar button: an icon, with an optional text label that hides on narrow screens. */
export function IconButton({ icon, label, active, className, ...rest }: BtnProps) {
  return (
    <button className={"ib" + (active ? " on" : "") + (className ? " " + className : "")} aria-label={rest.title ?? label} {...rest}>
      <Icon name={icon} />
      {label && <span className="lbl">{label}</span>}
    </button>
  );
}
