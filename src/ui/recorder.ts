// Records the presenter canvas (ink, reveals, laser) plus the microphone into a 1080p video.
// The HUD is HTML, so it never appears in the recording.

export const VIDEO_W = 1920;
export const VIDEO_H = 1080;

const TYPES = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export const canRecord = () =>
  typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function";

export class Recorder {
  readonly mime: string;
  readonly hasAudio: boolean;
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private loop = 0;
  private mic: MediaStream | null;
  private startedAt = performance.now();
  private pausedAt: number | null = null;
  private pausedTotal = 0;

  constructor(source: () => HTMLCanvasElement | null, background: string, mic: MediaStream | null) {
    const out = document.createElement("canvas");
    out.width = VIDEO_W;
    out.height = VIDEO_H;
    const ctx = out.getContext("2d")!;
    // Copy the on-screen canvas every frame, fitted into 16:9, so the video has a steady size and frame rate.
    const tick = () => {
      const src = source();
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
      if (src && src.width > 0 && src.height > 0) {
        const s = Math.min(VIDEO_W / src.width, VIDEO_H / src.height);
        const w = src.width * s;
        const h = src.height * s;
        ctx.drawImage(src, (VIDEO_W - w) / 2, (VIDEO_H - h) / 2, w, h);
      }
      this.loop = requestAnimationFrame(tick);
    };
    tick();
    const stream = out.captureStream(30);
    for (const t of mic?.getAudioTracks() ?? []) stream.addTrack(t);
    this.mic = mic;
    this.hasAudio = !!mic;
    this.mime = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    this.rec = new MediaRecorder(stream, { mimeType: this.mime || undefined, videoBitsPerSecond: 8_000_000, audioBitsPerSecond: 128_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(1000);
  }

  /** The microphone, or null when it is refused or missing (the video is then silent). */
  static async askMic(): Promise<MediaStream | null> {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch {
      return null;
    }
  }

  get paused() {
    return this.pausedAt !== null;
  }

  /** Recorded time so far, pauses left out. */
  elapsed(): number {
    const now = this.pausedAt ?? performance.now();
    return now - this.startedAt - this.pausedTotal;
  }

  pause() {
    if (this.pausedAt !== null || this.rec.state !== "recording") return;
    this.rec.pause();
    this.pausedAt = performance.now();
  }

  resume() {
    if (this.pausedAt === null) return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = null;
    this.rec.resume();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      this.rec.onstop = () => {
        this.release();
        resolve(new Blob(this.chunks, { type: this.mime || "video/webm" }));
      };
      if (this.rec.state === "inactive") this.rec.onstop(new Event("stop"));
      else this.rec.stop();
    });
  }

  private release() {
    cancelAnimationFrame(this.loop);
    for (const t of this.mic?.getTracks() ?? []) t.stop();
  }
}

export const videoExtension = (mime: string) => (mime.startsWith("video/mp4") ? "mp4" : "webm");

export function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
