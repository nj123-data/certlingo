"use client";

import { useEffect, useRef, useState } from "react";
import { ScreenshotResult } from "./StepImport";
import { StepStatus } from "./ChevronNav";

interface StepProcessProps {
  screenshots: ScreenshotResult[];
  onStatusChange: (status: StepStatus) => void;
  onComplete: (csvPath: string) => void;
}

interface OcrResult {
  filename: string;
  raw_ocr:  string;
  empty:    boolean;
}

interface Question {
  source_image:         string;
  question_number:      string;
  question_text:        string;
  option_A:             string;
  option_B:             string;
  option_C:             string;
  option_D:             string;
  correct_option:       string;
  explanation_option_A: string;
  explanation_option_B: string;
  explanation_option_C: string;
  explanation_option_D: string;
}

interface Job {
  id:       string;
  status:   string;
  progress: number;
  message:  string;
  result:   any;
  error:    string | null;
}

type SubStep = "A" | "B" | "C";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const POLL_MS  = 2000;

function isComplete(q: Question): boolean {
  return !!(
    q.question_text?.trim() &&
    q.option_A?.trim() &&
    q.option_B?.trim() &&
    q.option_C?.trim() &&
    q.option_D?.trim() &&
    q.correct_option?.trim()
  );
}

export default function StepProcess({
  screenshots,
  onStatusChange,
  onComplete,
}: StepProcessProps) {
  // ── Sub-step state ─────────────────────────────────────
  const [subStep, setSubStep] = useState<SubStep>("A");

  // ── Sub-step A: screenshots ────────────────────────────
  const [backendFiles, setBackendFiles]     = useState<string[]>([]);
  const [uploading, setUploading]           = useState(false);
  const [uploadDone, setUploadDone]         = useState(screenshots.length > 0);

  // ── Sub-step B: OCR ────────────────────────────────────
  const [ocrJob, setOcrJob]               = useState<Job | null>(null);
  const [ocrRunning, setOcrRunning]       = useState(false);
  const [ocrResults, setOcrResults]       = useState<OcrResult[]>([]);
  const [expandedOcr, setExpandedOcr]     = useState<Set<string>>(new Set());
  const [deletingFile, setDeletingFile]   = useState<string | null>(null);

  // ── Sub-step C: AI ─────────────────────────────────────
  const [showConfirm, setShowConfirm]     = useState(false);
  const [aiJob, setAiJob]                 = useState<Job | null>(null);
  const [aiRunning, setAiRunning]         = useState(false);
  const [questions, setQuestions]         = useState<Question[]>([]);

  // ── Shared ─────────────────────────────────────────────
  const [error, setError]   = useState("");
  const pollRef             = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // If screenshots came from Step 1, mark upload done
    if (screenshots.length > 0) setUploadDone(true);
    // Load any existing backend files on mount
    fetchBackendFiles();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  // ── A: fetch backend file list ─────────────────────────
  async function fetchBackendFiles() {
    try {
      const res  = await fetch(`${API}/api/screenshots`);
      const data = await res.json();
      setBackendFiles(data.screenshots ?? []);
    } catch {
      // non-fatal
    }
  }

  // ── A: manual file upload ──────────────────────────────
  async function handleManualUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError("");

    try {
      // Clear first
      await fetch(`${API}/api/screenshots/clear`, { method: "POST" });

      const form = new FormData();
      Array.from(files).forEach((f) => form.append("files", f, f.name));

      const res = await fetch(`${API}/api/screenshots/upload`, {
        method: "POST",
        body:   form,
      });

      if (!res.ok) throw new Error(`Upload failed (${res.status})`);

      await fetchBackendFiles();
      setUploadDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  // ── A: delete a screenshot ─────────────────────────────
  async function deleteScreenshot(filename: string) {
    setDeletingFile(filename);
    try {
      await fetch(`${API}/api/screenshots/${encodeURIComponent(filename)}`, {
        method: "DELETE",
      });
      setBackendFiles((prev) => prev.filter((f) => f !== filename));
      setOcrResults((prev) => prev.filter((r) => r.filename !== filename));
    } catch {
      // non-fatal
    } finally {
      setDeletingFile(null);
    }
  }

  // ── B: run OCR ─────────────────────────────────────────
  async function startOcr() {
    setOcrRunning(true);
    setError("");
    setOcrResults([]);

    try {
      const res  = await fetch(`${API}/api/ocr`, { method: "POST" });
      if (!res.ok) throw new Error(`Failed to start OCR (${res.status})`);
      const data = await res.json();
      pollOcr(data.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "OCR failed to start.");
      setOcrRunning(false);
    }
  }

  function pollOcr(id: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`${API}/api/jobs/${id}`);
        const data: Job = await res.json();
        setOcrJob(data);

        if (data.status === "done") {
          clearInterval(pollRef.current!);
          setOcrRunning(false);
          const results: OcrResult[] = data.result?.ocr_results ?? [];
          setOcrResults(results);
        }

        if (data.status === "failed") {
          clearInterval(pollRef.current!);
          setOcrRunning(false);
          setError(data.error ?? "OCR failed.");
        }
      } catch { /* keep polling */ }
    }, POLL_MS);
  }

  function toggleOcr(filename: string) {
    setExpandedOcr((prev) => {
      const next = new Set(prev);
      next.has(filename) ? next.delete(filename) : next.add(filename);
      return next;
    });
  }

  // ── C: run Gemini AI ───────────────────────────────────
  async function startAi() {
    setShowConfirm(false);
    setAiRunning(true);
    setError("");
    setQuestions([]);
    onStatusChange("active");

    try {
      const res  = await fetch(`${API}/api/process`, { method: "POST" });
      if (!res.ok) throw new Error(`Failed to start AI (${res.status})`);
      const data = await res.json();
      pollAi(data.job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "AI processing failed.");
      setAiRunning(false);
      onStatusChange("error");
    }
  }

  function pollAi(id: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`${API}/api/jobs/${id}`);
        const data: Job = await res.json();
        setAiJob(data);

        if (data.status === "done") {
          clearInterval(pollRef.current!);
          setAiRunning(false);
          onStatusChange("done");
          fetchQuestions();
          if (data.result?.csv_path) onComplete(data.result.csv_path);
        }

        if (data.status === "failed") {
          clearInterval(pollRef.current!);
          setAiRunning(false);
          setError(data.error ?? "AI processing failed.");
          onStatusChange("error");
        }
      } catch { /* keep polling */ }
    }, POLL_MS);
  }

  async function fetchQuestions() {
    try {
      const res  = await fetch(`${API}/api/questions/preview`);
      const data = await res.json();
      setQuestions(data.questions ?? []);
    } catch { /* non-fatal */ }
  }

  const complete   = questions.filter(isComplete);
  const incomplete = questions.filter((q) => !isComplete(q));

  // ── C: load existing CSV ───────────────────────────────
  async function handleCsvUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError("");

    try {
      const form = new FormData();
      form.append("file", files[0], files[0].name);

      const res = await fetch(`${API}/api/questions/upload-csv`, {
        method: "POST",
        body:   form,
      });

      if (!res.ok) throw new Error(`Upload failed (${res.status})`);

      const data = await res.json();
      onComplete(data.csv_path);
      await fetchQuestions();
      onStatusChange("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "CSV upload failed.");
    }
  }

  // ── Download helpers ───────────────────────────────────
  function downloadOcrJson() {
    const payload = ocrResults.map((r) => ({
      filename: r.filename,
      empty:    r.empty,
      raw_ocr:  r.raw_ocr,
    }));
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `ocr-output-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadCsv() {
    const headers = [
      "source_image","question_number","question_text",
      "option_A","option_B","option_C","option_D","correct_option",
      "explanation_option_A","explanation_option_B","explanation_option_C","explanation_option_D",
    ];
    const escape = (v: string) => `"${(v ?? "").replace(/"/g, '""')}"`;
    const rows   = questions.map((q) => headers.map((h) => escape((q as any)[h])).join(","));
    const csv    = [headers.join(","), ...rows].join("\n");
    const blob   = new Blob([csv], { type: "text/csv" });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement("a");
    a.href       = url;
    a.download   = `questions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Sub-step pill nav ──────────────────────────────────
  function SubStepNav() {
    const steps = [
      { id: "A", label: "Screenshots" },
      { id: "B", label: "OCR Review"  },
      { id: "C", label: "AI Parse"    },
    ] as const;

    const doneA = uploadDone && backendFiles.length > 0;
    const doneB = ocrResults.length > 0;
    const doneC = questions.length > 0;

    return (
      <div className="flex items-center gap-2 mb-6">
        {steps.map((s, i) => {
          const isActive = subStep === s.id;
          const isDone   =
            s.id === "A" ? doneA :
            s.id === "B" ? doneB : doneC;

          return (
            <div key={s.id} className="flex items-center gap-2">
              <button
                onClick={() => setSubStep(s.id)}
                className={`
                  flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold
                  transition-all border
                  ${isActive
                    ? "bg-[#1e3a5f] text-white border-[#1e3a5f]"
                    : isDone
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-slate-100 text-slate-400 border-slate-200"
                  }
                `}
              >
                {isDone && !isActive
                  ? <span>✓</span>
                  : <span className="font-mono">{s.id}</span>
                }
                {s.label}
              </button>
              {i < steps.length - 1 && (
                <span className="text-slate-300 text-xs">→</span>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">

        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest">
            Process Data
          </h3>
        </div>

        <SubStepNav />

        {/* ── Sub-step A: Screenshots ─────────────────── */}
        {subStep === "A" && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-700 mb-1">
                Screenshots in backend
              </p>
              <p className="text-xs text-slate-400">
                Use screenshots from Step 1, or upload your own JPEGs directly.
              </p>
            </div>

            {/* Manual upload */}
            <div className="flex items-center gap-3">
              <label className={`
                px-4 py-2 rounded-xl border text-sm font-semibold cursor-pointer
                transition-colors
                ${uploading
                  ? "opacity-40 cursor-not-allowed border-slate-200 text-slate-400"
                  : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }
              `}>
                {uploading ? "Uploading..." : "Upload Screenshots"}
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  disabled={uploading}
                  className="hidden"
                  onChange={(e) => handleManualUpload(e.target.files)}
                />
              </label>

              <button
                onClick={fetchBackendFiles}
                className="px-4 py-2 rounded-xl border border-slate-200 text-sm text-slate-500 hover:bg-slate-50"
              >
                Refresh
              </button>

              {backendFiles.length > 0 && (
                <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold border border-emerald-200">
                  ✓ {backendFiles.length} files
                </span>
              )}
            </div>

            {error && (
              <p className="text-xs text-rose-600 font-medium">⚠ {error}</p>
            )}

            {/* Thumbnail grid */}
            {backendFiles.length > 0 ? (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 max-h-[400px] overflow-y-auto pr-1">
                  {backendFiles.map((filename) => (
                    <div
                      key={filename}
                      className="group relative overflow-hidden rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-md transition-all"
                    >
                      <img
                        src={`${API}/screenshots/${filename}`}
                        alt={filename}
                        className="aspect-video w-full object-contain bg-slate-50"
                      />
                      <div className="p-2 flex items-center justify-between">
                        <p className="text-xs font-mono text-slate-500 truncate">
                          {filename}
                        </p>
                        <button
                          onClick={() => deleteScreenshot(filename)}
                          disabled={deletingFile === filename}
                          className="ml-1 w-5 h-5 flex items-center justify-center rounded-full text-slate-300 hover:bg-rose-50 hover:text-rose-500 transition-colors shrink-0"
                          title="Delete"
                        >
                          {deletingFile === filename ? "…" : "✕"}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={() => setSubStep("B")}
                    className="px-5 py-2.5 rounded-xl bg-[#1e3a5f] text-white text-sm font-bold hover:bg-[#152a47] transition-colors"
                  >
                    Proceed to OCR →
                  </button>
                </div>
              </>
            ) : (
              <div className="rounded-xl border-2 border-dashed border-slate-200 p-10 text-center">
                <p className="text-sm font-semibold text-slate-500">
                  No screenshots yet
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  Complete Step 1 or upload screenshots manually above
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Sub-step B: OCR Review ──────────────────── */}
        {subStep === "B" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-700">
                  Tesseract OCR
                </p>
                <p className="text-xs text-slate-400 mt-0.5">
                  Extract raw text from each screenshot. Review before running AI.
                </p>
              </div>
              <button
                onClick={startOcr}
                disabled={ocrRunning}
                className="px-5 py-2.5 rounded-xl bg-[#1e3a5f] text-white text-sm font-bold hover:bg-[#152a47] transition-colors disabled:opacity-40"
              >
                {ocrRunning
                  ? "Running OCR..."
                  : ocrResults.length > 0
                  ? "Re-run OCR"
                  : "Run OCR"}
              </button>
            </div>

            {/* OCR progress */}
            {ocrRunning && ocrJob && (
              <div>
                <div className="flex justify-between text-xs text-slate-500 mb-1.5">
                  <span>{ocrJob.message}</span>
                  <span className="font-mono font-bold">{ocrJob.progress}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-[#1e3a5f] rounded-full transition-all duration-300"
                    style={{ width: `${ocrJob.progress}%` }}
                  />
                </div>
              </div>
            )}

            {error && (
              <p className="text-xs text-rose-600 font-medium">⚠ {error}</p>
            )}

            {/* OCR results list */}
            {ocrResults.length > 0 && (
              <>
                <div className="space-y-2 max-h-[480px] overflow-y-auto pr-1">
                  {ocrResults.map((r) => (
                    <div
                      key={r.filename}
                      className={`rounded-xl border transition-all ${
                        r.empty
                          ? "border-amber-200 bg-amber-50/50"
                          : "border-slate-200 bg-white"
                      }`}
                    >
                      <div className="flex items-center justify-between px-4 py-2.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <button
                            onClick={() => toggleOcr(r.filename)}
                            className="text-slate-400 hover:text-slate-600 transition-colors shrink-0"
                          >
                            {expandedOcr.has(r.filename) ? "▾" : "▸"}
                          </button>
                          <span className="text-xs font-mono text-slate-600 truncate">
                            {r.filename}
                          </span>
                          {r.empty && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 font-bold shrink-0">
                              Empty OCR
                            </span>
                          )}
                        </div>
                        <button
                          onClick={() => deleteScreenshot(r.filename)}
                          disabled={deletingFile === r.filename}
                          className="ml-2 text-xs text-slate-300 hover:text-rose-500 transition-colors shrink-0 font-bold"
                          title="Remove from batch"
                        >
                          {deletingFile === r.filename ? "…" : "✕"}
                        </button>
                      </div>

                      {expandedOcr.has(r.filename) && (
                        <div className="px-4 pb-3 border-t border-slate-100">
                          {r.raw_ocr ? (
                            <pre className="mt-2 text-[11px] text-slate-600 whitespace-pre-wrap font-mono leading-relaxed bg-slate-50 rounded-lg p-3 max-h-40 overflow-y-auto">
                              {r.raw_ocr}
                            </pre>
                          ) : (
                            <p className="mt-2 text-xs text-amber-600 italic">
                              No text extracted from this image.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="flex items-center justify-between pt-2">
                  <p className="text-xs text-slate-400">
                    {ocrResults.filter((r) => !r.empty).length} of {ocrResults.length} images have text
                    {ocrResults.some((r) => r.empty) && (
                      <span className="text-amber-600 ml-1">
                        · {ocrResults.filter((r) => r.empty).length} empty (consider removing)
                      </span>
                    )}
                  </p>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={downloadOcrJson}
                      className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold hover:bg-slate-50 transition-colors"
                      title="Download raw OCR output as JSON"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download OCR
                    </button>
                    <button
                      onClick={() => setSubStep("C")}
                      className="px-5 py-2.5 rounded-xl bg-[#1e3a5f] text-white text-sm font-bold hover:bg-[#152a47] transition-colors"
                    >
                      Proceed to AI →
                    </button>
                  </div>
                </div>
              </>
            )}

            {!ocrRunning && ocrResults.length === 0 && (
              <div className="rounded-xl border-2 border-dashed border-slate-200 p-10 text-center">
                <p className="text-sm font-semibold text-slate-500">
                  Click Run OCR to extract text
                </p>
                <p className="text-xs text-slate-400 mt-1">
                  No AI tokens used at this stage
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Sub-step C: AI Parse ────────────────────── */}
        {subStep === "C" && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-slate-700">
                Gemini AI Parsing
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Structure OCR text into questions, options, answers and explanations.
              </p>
            </div>

                {/* Confirmation prompt */}
            {!aiRunning && questions.length === 0 && !showConfirm && (
              <div className="space-y-3">
                <div className="rounded-xl border-2 border-dashed border-amber-200 bg-amber-50/40 p-8 text-center space-y-3">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center mx-auto">
                    <span className="text-amber-600 text-lg">✦</span>
                  </div>
                  <p className="text-sm font-bold text-slate-700">
                    Ready to run Gemini AI
                  </p>
                  <p className="text-xs text-slate-500">
                    {ocrResults.length > 0
                      ? `${ocrResults.filter((r) => !r.empty).length} screenshots with text will be sent to Gemini.`
                      : `${backendFiles.length} screenshots will be processed.`
                    }
                    {" "}This uses Gemini API tokens.
                  </p>
                  <button
                    onClick={() => setShowConfirm(true)}
                    className="px-5 py-2.5 rounded-xl bg-amber-500 text-slate-900 text-sm font-bold hover:bg-amber-400 transition-colors"
                  >
                    Run AI Parse →
                  </button>
                </div>

                {/* Load existing CSV */}
                <div className="rounded-xl border border-slate-200 bg-white p-5">
                  <p className="text-sm font-semibold text-slate-700 mb-1">
                    Already have a CSV?
                  </p>
                  <p className="text-xs text-slate-400 mb-3">
                    Upload a previously generated CSV to skip AI processing and go straight to Step 3.
                  </p>
                  <label className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-slate-300 text-sm font-semibold text-slate-600 hover:bg-slate-50 cursor-pointer transition-colors">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                    </svg>
                    Upload CSV
                    <input
                      type="file"
                      accept=".csv"
                      className="hidden"
                      onChange={(e) => handleCsvUpload(e.target.files)}
                    />
                  </label>
                </div>
              </div>
            )}

            {/* Confirm dialog */}
            {showConfirm && (
              <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-6 space-y-4">
                <p className="text-sm font-bold text-slate-800">
                  Confirm AI Processing
                </p>
                <p className="text-xs text-slate-600">
                  This will send{" "}
                  <span className="font-bold text-slate-800">
                    {ocrResults.filter((r) => !r.empty).length || backendFiles.length} images
                  </span>{" "}
                  to Gemini. The process cannot be paused once started.
                  Make sure you have reviewed and removed any unwanted screenshots in steps A and B.
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={startAi}
                    className="px-5 py-2.5 rounded-xl bg-[#1e3a5f] text-white text-sm font-bold hover:bg-[#152a47] transition-colors"
                  >
                    Confirm — Run Gemini
                  </button>
                  <button
                    onClick={() => setShowConfirm(false)}
                    className="px-5 py-2.5 rounded-xl border border-slate-300 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* AI progress */}
            {aiRunning && aiJob && (
              <div>
                <div className="flex justify-between text-xs text-slate-500 mb-1.5">
                  <span>{aiJob.message}</span>
                  <span className="font-mono font-bold">{aiJob.progress}%</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full bg-[#1e3a5f] rounded-full transition-all duration-500"
                    style={{ width: `${aiJob.progress}%` }}
                  />
                </div>
                <p className="mt-1.5 text-xs text-slate-400">
                  Do not close this window while processing.
                </p>
              </div>
            )}

            {error && (
              <p className="text-xs text-rose-600 font-medium">⚠ {error}</p>
            )}

            {/* Questions table */}
            {questions.length > 0 && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex gap-2">
                    <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold border border-emerald-200">
                      ✓ {complete.length} complete
                    </span>
                    {incomplete.length > 0 && (
                      <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-bold border border-amber-200">
                        ⚠ {incomplete.length} flagged
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={downloadCsv}
                      className="flex items-center gap-1.5 px-4 py-2.5 rounded-xl border border-slate-300 text-slate-600 text-sm font-semibold hover:bg-slate-50 transition-colors"
                      title="Download parsed questions as CSV"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download CSV
                    </button>
                    <button
                      onClick={() => onComplete(aiJob?.result?.csv_path ?? "")}
                      className="px-5 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
                    >
                      Proceed to Step 3 →
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto rounded-xl border border-slate-200">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 border-b border-slate-200">
                        <th className="text-left px-3 py-2.5 font-bold text-slate-500 w-10">#</th>
                        <th className="text-left px-3 py-2.5 font-bold text-slate-500">Question</th>
                        <th className="text-left px-3 py-2.5 font-bold text-slate-500 w-16">Answer</th>
                        <th className="text-left px-3 py-2.5 font-bold text-slate-500 w-20">Status</th>
                        <th className="text-left px-3 py-2.5 font-bold text-slate-500 w-24">Source</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {questions.map((q, i) => {
                        const ok = isComplete(q);
                        return (
                          <tr
                            key={i}
                            className={`hover:bg-slate-50 ${!ok ? "bg-amber-50/50" : ""}`}
                          >
                            <td className="px-3 py-2.5 font-mono text-slate-400">
                              {q.question_number || i + 1}
                            </td>
                            <td className="px-3 py-2.5 text-slate-700 max-w-md">
                              <p className="line-clamp-2 leading-relaxed">
                                {q.question_text || (
                                  <span className="text-slate-400 italic">No question text</span>
                                )}
                              </p>
                            </td>
                            <td className="px-3 py-2.5">
                              {q.correct_option ? (
                                <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">
                                  {q.correct_option}
                                </span>
                              ) : (
                                <span className="text-slate-300">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              {ok
                                ? <span className="text-emerald-600 font-semibold">✓ OK</span>
                                : <span className="text-amber-600 font-semibold">⚠ Flag</span>
                              }
                            </td>
                            <td className="px-3 py-2.5 font-mono text-slate-400 truncate max-w-[6rem]">
                              {q.source_image}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}