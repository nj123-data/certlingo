"use client";

import { useRef, useState } from "react";
import JSZip from "jszip";
import { StepStatus } from "./ChevronNav";

interface StepImportProps {
  onStatusChange: (status: StepStatus) => void;
  onComplete: (screenshots: ScreenshotResult[]) => void;
}

export interface ScreenshotResult {
  timestamp: number;
  filename: string;
  blob: Blob;
  url: string;
}

const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.85;
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

function formatTime(seconds: number) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join("-");
}

function timeLabel(seconds: number) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas
): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
  }
  return new Promise((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Encode failed"))),
      "image/jpeg",
      JPEG_QUALITY
    );
  });
}

function sanitiseFilename(name: string): string {
  // Remove file extension
  const stem = name.replace(/\.[^.]+$/, "");
  // Replace any character that isn't alphanumeric, hyphen, or underscore with hyphen
  const clean = stem.replace(/[^a-zA-Z0-9\-_]/g, "-");
  // Collapse multiple hyphens
  return clean.replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export default function StepImport({
  onStatusChange,
  onComplete,
}: StepImportProps) {
  const [file, setFile] = useState<File | null>(null);
  const [intervalSecs, setIntervalSecs] = useState(90);
  const [screenshots, setScreenshots] = useState<ScreenshotResult[]>([]);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Choose a video file to begin.");
  const [running, setRunning] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadDone, setUploadDone] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [duration, setDuration] = useState<number | null>(null);
  const [error, setError] = useState("");
  const cancelRef = useRef(false);

  // ── Extraction ───────────────────────────────────────────
  async function extract() {
    if (!file || running) return;

    setRunning(true);
    setProgress(0);
    setElapsed(null);
    setDuration(null);
    setError("");
    setScreenshots([]);
    setUploadDone(false);
    setUploadProgress(0);
    cancelRef.current = false;
    onStatusChange("active");

    const start = performance.now();
    const newScreenshots: ScreenshotResult[] = [];

    try {
      const { Input, BlobSource, ALL_FORMATS, CanvasSink } =
        await import("mediabunny");

      const input = new Input({
        source: new BlobSource(file),
        formats: ALL_FORMATS,
      });

      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) throw new Error("No video track found in this file.");

      const videoDuration = await input.computeDuration();
      if (!Number.isFinite(videoDuration) || videoDuration <= 0)
        throw new Error("Could not determine video duration.");

      setDuration(videoDuration);

      const width = Math.min(MAX_WIDTH, await videoTrack.getDisplayWidth());
      const sink = new CanvasSink(videoTrack, { width, poolSize: 1 });

      const timestamps: number[] = [];
      for (let t = 0; t < videoDuration; t += intervalSecs) {
        timestamps.push(t);
      }

      setStatus(
        `Extracting ${timestamps.length} frames at ${intervalSecs}s intervals...`
      );

      let completed = 0;

      for await (const item of sink.canvasesAtTimestamps(timestamps)) {
        if (cancelRef.current) break;

        if (item) {
          const blob = await canvasToBlob(item.canvas);
          const filename = `${sanitiseFilename(file.name)}-${formatTime(item.timestamp)}.jpg`;
          newScreenshots.push({
            timestamp: item.timestamp,
            filename,
            blob,
            url: URL.createObjectURL(blob),
          });
        }

        completed++;
        setProgress(Math.round((completed / timestamps.length) * 100));

        if (completed % 5 === 0 || completed === timestamps.length) {
          setStatus(
            `Captured ${newScreenshots.length} of ${timestamps.length} frames`
          );
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }
      }

      const finalShots = [...newScreenshots];
      const totalElapsed = (performance.now() - start) / 1000;

      setScreenshots(finalShots);
      setElapsed(totalElapsed);
      setProgress(100);

      if (cancelRef.current) {
        setStatus(`Cancelled — ${finalShots.length} frames captured`);
        onStatusChange("idle");
      } else {
        setStatus(`Complete — ${finalShots.length} screenshots ready`);
        onStatusChange("done");
      }
    } catch (err) {
      newScreenshots.forEach((s) => URL.revokeObjectURL(s.url));
      setError(err instanceof Error ? err.message : "Processing failed.");
      setStatus("Extraction failed.");
      onStatusChange("error");
    } finally {
      setRunning(false);
    }
  }

  // ── Upload ───────────────────────────────────────────────
  async function uploadToBackend(shots: ScreenshotResult[]) {
    if (!shots.length) return;

    setUploading(true);
    setUploadProgress(0);
    setError("");

    try {
      // 1 — clear previous session
      const clearRes = await fetch(`${API}/api/screenshots/clear`, {
        method: "POST",
      });
      if (!clearRes.ok) {
        throw new Error(`Clear failed with status ${clearRes.status}`);
      }

      setUploadProgress(10);

      // 2 — build form and upload all at once
      const form = new FormData();
      for (const shot of shots) {
        form.append("files", shot.blob, shot.filename);
      }

      const uploadRes = await fetch(`${API}/api/screenshots/upload`, {
        method: "POST",
        body: form,
      });

      if (!uploadRes.ok) {
        const text = await uploadRes.text().catch(() => "Unknown error");
        throw new Error(`Upload failed with status ${uploadRes.status}: ${text}`);
      }

      const data = await uploadRes.json().catch(() => null);
      const savedCount: number =
        data && typeof data.total === "number" ? data.total : shots.length;

      setUploadProgress(100);
      setUploadDone(true);
      setStatus(`✓ ${savedCount} screenshots saved to backend`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  // ── Cancel extraction ────────────────────────────────────
  function cancel() {
    cancelRef.current = true;
    setStatus("Cancelling after current frame...");
  }

  // ── Download ZIP ─────────────────────────────────────────
  async function downloadZip() {
    if (!screenshots.length) return;
    setStatus("Building ZIP archive...");
    const zip = new JSZip();
    const folder = zip.folder("screenshots");
    for (const shot of screenshots) folder?.file(shot.filename, shot.blob);
    const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "certlingo-screenshots.zip";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus("ZIP download started.");
  }

  // ── Reset ────────────────────────────────────────────────
  function reset() {
    if (running || uploading) return;
    screenshots.forEach((s) => URL.revokeObjectURL(s.url));
    setScreenshots([]);
    setFile(null);
    setProgress(0);
    setUploadProgress(0);
    setUploadDone(false);
    setElapsed(null);
    setDuration(null);
    setError("");
    setStatus("Choose a video file to begin.");
    onStatusChange("idle");
  }

  // ── Render ───────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* Controls card */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
        <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest mb-4">
          Video Source
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
          {/* File picker */}
          <div className="md:col-span-2">
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Select MP4 file
            </label>
            <input
              type="file"
              accept="video/*,.mkv"
              disabled={running || uploading}
              className="block w-full text-sm text-slate-500 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 disabled:opacity-50 cursor-pointer"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                screenshots.forEach((s) => URL.revokeObjectURL(s.url));
                setScreenshots([]);
                setElapsed(null);
                setDuration(null);
                setError("");
                setProgress(0);
                setUploadProgress(0);
                setUploadDone(false);
                setFile(f);
              }}
            />
            {file && (
              <p className="mt-2 text-xs text-slate-400">
                {file.name}&nbsp;·&nbsp;
                {(file.size / (1024 * 1024)).toFixed(1)} MB
              </p>
            )}
          </div>

          {/* Interval */}
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1.5">
              Interval (seconds)
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={5}
                max={300}
                value={intervalSecs}
                disabled={running || uploading}
                onChange={(e) => setIntervalSecs(Number(e.target.value))}
                className="w-24 px-3 py-2 rounded-lg border border-slate-200 text-sm font-mono font-semibold text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-900/30 disabled:opacity-50"
              />
              <span className="text-xs text-slate-400">default 90s</span>
            </div>
          </div>
        </div>

        {/* Buttons */}
        <div className="mt-5 flex flex-wrap gap-3 items-center">
          <button
            onClick={extract}
            disabled={!file || running || uploading}
            className="px-5 py-2.5 rounded-xl bg-[#1e3a5f] text-white text-sm font-bold disabled:opacity-40 hover:bg-[#152a47] transition-colors"
          >
            {running ? "Extracting..." : "Extract Screenshots"}
          </button>

          {running && (
            <button
              onClick={cancel}
              className="px-5 py-2.5 rounded-xl border border-slate-300 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              Cancel
            </button>
          )}

          {!running && screenshots.length > 0 && (
            <>
              <button
                onClick={downloadZip}
                disabled={uploading}
                className="px-5 py-2.5 rounded-xl border border-slate-300 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Download ZIP
              </button>

              <button
                onClick={reset}
                disabled={uploading}
                className="px-5 py-2.5 rounded-xl border border-slate-300 text-sm font-semibold text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                Reset
              </button>

              {!uploadDone ? (
                <button
                  onClick={() => uploadToBackend(screenshots)}
                  disabled={uploading}
                  className="ml-auto px-5 py-2.5 rounded-xl bg-[#1e3a5f] text-white text-sm font-bold hover:bg-[#152a47] transition-colors disabled:opacity-40"
                >
                  {uploading ? "Uploading..." : "Proceed to Step 2 →"}
                </button>
              ) : (
                <button
                  onClick={() => onComplete(screenshots)}
                  className="ml-auto px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
                >
                  Continue to Step 2 ✓
                </button>
              )}
            </>
          )}
        </div>

        {/* Progress indicators */}
        <div className="mt-5 space-y-3" aria-live="polite">

          {/* Extraction bar */}
          <div>
            <div className="flex justify-between text-xs text-slate-500 mb-1.5">
              <span>{status}</span>
              <span className="font-mono font-bold">{progress}%</span>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div
                className="h-full bg-[#1e3a5f] rounded-full transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Upload bar */}
          {(uploading || uploadDone) && (
            <div>
              <div className="flex justify-between text-xs text-slate-500 mb-1.5">
                <span>
                  {uploadDone
                    ? `✓ Screenshots saved to backend`
                    : `Uploading to backend...`}
                </span>
                <span className="font-mono font-bold">{uploadProgress}%</span>
              </div>
              <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-300 ${
                    uploadDone ? "bg-emerald-500" : "bg-amber-400"
                  }`}
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {duration !== null && (
            <div className="flex gap-4 text-xs text-slate-400">
              <span>Duration: {timeLabel(duration)}</span>
              <span>
                Target frames: {Math.ceil(duration / intervalSecs)}
              </span>
            </div>
          )}

          {elapsed !== null && (
            <p className="text-xs font-semibold text-emerald-600">
              ✓ Extracted in {elapsed.toFixed(1)}s
            </p>
          )}

          {error && (
            <p className="text-xs text-rose-600 font-medium">⚠ {error}</p>
          )}
        </div>
      </div>

      {/* Thumbnail grid */}
      {screenshots.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-slate-700">
                Extracted Screenshots
              </h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {screenshots.length} images · click any to download individually
              </p>
            </div>
            <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold border border-emerald-200">
              ✓ {screenshots.length} frames
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
            {screenshots.map((shot) => (
              <a
                key={shot.filename}
                href={shot.url}
                download={shot.filename}
                className="group overflow-hidden rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-md transition-all"
              >
                <img
                  src={shot.url}
                  alt={`Frame at ${timeLabel(shot.timestamp)}`}
                  className="aspect-video w-full object-contain bg-slate-50"
                />
                <div className="p-2">
                  <p className="text-xs font-mono font-semibold text-slate-600">
                    {timeLabel(shot.timestamp)}
                  </p>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

    </div>
  );
}