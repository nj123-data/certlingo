"use client";

import { useEffect, useState } from "react";
import { StepStatus } from "./ChevronNav";

interface StepLoadProps {
  csvPath:        string;
  onStatusChange: (status: StepStatus) => void;
  onComplete:     () => void;
}

interface Question {
  question_number: string;
  question_text:   string;
  option_A:        string;
  option_B:        string;
  option_C:        string;
  option_D:        string;
  correct_option:  string;
  source_image:    string;
  [key: string]: string;
}

interface LoadResult {
  csv:      string;
  total:    number;
  inserted: number;
  skipped:  number;
  failed:   number;
  details:  { row: number; status: string; reason?: string }[];
}

interface DbStatus {
  connected:      boolean;
  question_count?: number;
  error?:         string;
}

const API = "http://localhost:8000";

function isComplete(q: Question): boolean {
  return !!(q.question_text?.trim() && q.option_A?.trim() && q.correct_option?.trim());
}

export default function StepLoad({ csvPath, onStatusChange, onComplete }: StepLoadProps) {
  const [preview,    setPreview]    = useState<Question[]>([]);
  const [dbStatus,   setDbStatus]   = useState<DbStatus | null>(null);
  const [loading,    setLoading]    = useState(false);
  const [loadResult, setLoadResult] = useState<LoadResult | null>(null);
  const [error,      setError]      = useState("");

  useEffect(() => {
    fetchPreview();
    checkDb();
  }, []);

  async function fetchPreview() {
    try {
      const res  = await fetch(`${API}/api/questions/preview`);
      const data = await res.json();
      setPreview(data.questions ?? []);
    } catch { /* non-fatal */ }
  }

  async function checkDb() {
    try {
      const res  = await fetch(`${API}/api/db/status`);
      const data = await res.json();
      setDbStatus(data);
    } catch {
      setDbStatus({ connected: false, error: "Could not reach backend" });
    }
  }

  async function runLoad() {
    setLoading(true);
    setError("");
    setLoadResult(null);
    onStatusChange("active");

    try {
      const res  = await fetch(`${API}/api/load`, { method: "POST" });
      const data = await res.json();

      if (!res.ok) throw new Error(data.detail ?? "Load failed");

      setLoadResult(data);
      onStatusChange(data.failed === data.total ? "error" : "done");
      checkDb();

      if (data.inserted > 0) onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Load failed.");
      onStatusChange("error");
    } finally {
      setLoading(false);
    }
  }

  const complete   = preview.filter(isComplete);
  const incomplete = preview.filter((q) => !isComplete(q));

  return (
    <div className="space-y-6">

      {/* DB status + header */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest">
              Load into Database
            </h3>
            <p className="text-xs text-slate-400 mt-1">
              Validate CSV and import questions into SQL Server
            </p>
          </div>

          {/* DB connection pill */}
          <button
            onClick={checkDb}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-slate-200 text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-colors"
          >
            <span className={`w-2 h-2 rounded-full ${
              dbStatus === null      ? "bg-slate-300" :
              dbStatus.connected     ? "bg-emerald-400" : "bg-rose-500"
            }`} />
            {dbStatus === null
              ? "Checking DB…"
              : dbStatus.connected
              ? `DB connected · ${dbStatus.question_count ?? 0} rows`
              : "DB offline"}
          </button>
        </div>

        {dbStatus && !dbStatus.connected && (
          <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
            <p className="text-xs font-semibold text-rose-700">
              ⚠ Cannot connect to SQL Server
            </p>
            <p className="text-xs text-rose-600 mt-0.5">{dbStatus.error}</p>
            <p className="text-xs text-slate-500 mt-1">
              Check that SQL Server is running and your <code>.env</code> values match.
            </p>
          </div>
        )}
      </div>

      {/* CSV preview */}
      {preview.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-700">CSV Preview</h3>
              <p className="text-xs text-slate-400 mt-0.5">
                {preview.length} rows · review before importing
              </p>
            </div>
            <div className="flex gap-2">
              <span className="px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-bold border border-emerald-200">
                ✓ {complete.length} ready
              </span>
              {incomplete.length > 0 && (
                <span className="px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 text-xs font-bold border border-amber-200">
                  ⚠ {incomplete.length} flagged
                </span>
              )}
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
                {preview.map((q, i) => {
                  const ok = isComplete(q);
                  return (
                    <tr key={i} className={`hover:bg-slate-50 ${!ok ? "bg-amber-50/50" : ""}`}>
                      <td className="px-3 py-2.5 font-mono text-slate-400">
                        {q.question_number || i + 1}
                      </td>
                      <td className="px-3 py-2.5 text-slate-700 max-w-md">
                        <p className="line-clamp-2 leading-relaxed">{q.question_text || (
                          <span className="text-slate-400 italic">No question text</span>
                        )}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        {q.correct_option
                          ? <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 font-bold border border-emerald-200">{q.correct_option}</span>
                          : <span className="text-slate-300">—</span>
                        }
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

          {/* Load button */}
          {!loadResult && (
            <div className="flex justify-end">
              <button
                onClick={runLoad}
                disabled={loading || !dbStatus?.connected}
                className="px-6 py-2.5 rounded-xl bg-[#1e3a5f] text-white text-sm font-bold hover:bg-[#152a47] transition-colors disabled:opacity-40"
              >
                {loading ? "Importing…" : `Import ${preview.length} Questions →`}
              </button>
            </div>
          )}
        </div>
      )}

      {/* No preview yet */}
      {preview.length === 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <div className="rounded-xl border-2 border-dashed border-slate-200 p-10 text-center">
            <p className="text-sm font-semibold text-slate-500">No CSV data found</p>
            <p className="text-xs text-slate-400 mt-1">Complete Step 2 to generate parsed questions</p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
          <p className="text-xs font-semibold text-rose-700">⚠ {error}</p>
        </div>
      )}

      {/* Load result summary */}
      {loadResult && (
        <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
          <h3 className="text-sm font-bold text-slate-700">Import Complete</h3>

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-4 text-center">
              <p className="text-2xl font-extrabold text-emerald-700">{loadResult.inserted}</p>
              <p className="text-xs text-emerald-600 font-semibold mt-1">Inserted</p>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-center">
              <p className="text-2xl font-extrabold text-amber-700">{loadResult.skipped}</p>
              <p className="text-xs text-amber-600 font-semibold mt-1">Skipped (duplicate)</p>
            </div>
            <div className="rounded-xl bg-rose-50 border border-rose-200 p-4 text-center">
              <p className="text-2xl font-extrabold text-rose-700">{loadResult.failed}</p>
              <p className="text-xs text-rose-600 font-semibold mt-1">Failed</p>
            </div>
          </div>

          {loadResult.failed > 0 && (
            <details className="rounded-xl border border-rose-200 bg-rose-50/50">
              <summary className="px-4 py-2.5 text-xs font-semibold text-rose-700 cursor-pointer">
                Show failed rows ({loadResult.details.filter(d => d.status === "failed").length})
              </summary>
              <div className="px-4 pb-3 space-y-1">
                {loadResult.details
                  .filter((d) => d.status === "failed")
                  .map((d, i) => (
                    <p key={i} className="text-xs text-rose-600 font-mono">
                      Row {d.row}: {d.reason}
                    </p>
                  ))}
              </div>
            </details>
          )}

          <div className="flex justify-end">
            <button
              onClick={onComplete}
              className="px-6 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 transition-colors"
            >
              Continue to Step 4 →
            </button>
          </div>
        </div>
      )}

    </div>
  );
}