"use client";

import { useState, useEffect } from "react";
import ChevronNav, { Step, StepStatus } from "@/components/ChevronNav";
import StepImport, { ScreenshotResult } from "@/components/StepImport";
import StepProcess from "@/components/StepProcess";
import StepLoad from "@/components/StepLoad";
import StepPublish from "@/components/StepPublish";

const STEP_DEFS = [
  { id: 1, label: "Import Questions", sublabel: "Extract video screenshots", icon: "upload"   },
  { id: 2, label: "Process Data",     sublabel: "OCR + Gemini parsing",      icon: "cpu"      },
  { id: 3, label: "Load Data",        sublabel: "Validate + import to DB",   icon: "database" },
  { id: 4, label: "Publish",          sublabel: "Connect to question bank",  icon: "globe"    },
];

export default function DashboardPage() {
  const [currentStep,  setCurrentStep]  = useState(1);
  const [screenshots,  setScreenshots]  = useState<ScreenshotResult[]>([]);
  const [csvPath,      setCsvPath]      = useState("");
  const [backendOnline, setBackendOnline] = useState(false);

  const [stepStatuses, setStepStatuses] = useState<Record<number, StepStatus>>({
    1: "active",
    2: "idle",
    3: "idle",
    4: "idle",
  });

  // ── Backend health poll ──────────────────────────────────
  useEffect(() => {
    async function checkHealth() {
      try {
        // page.tsx — replace the hardcoded URL
        const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"}/api/health`);
        setBackendOnline(res.ok);
      } catch {
        setBackendOnline(false);
      }
    }
    checkHealth();
    const interval = setInterval(checkHealth, 10_000);
    return () => clearInterval(interval);
  }, []);

  // ── Step helpers ─────────────────────────────────────────
  function setStepStatus(stepId: number, status: StepStatus) {
    setStepStatuses((prev) => ({ ...prev, [stepId]: status }));
  }

  function advanceToStep(nextStep: number) {
    setCurrentStep(nextStep);
    setStepStatuses((prev) => ({ ...prev, [nextStep]: "active" }));
  }

  const steps: Step[] = STEP_DEFS.map((s) => ({
    ...s,
    status: stepStatuses[s.id],
  }));

  // ── Render ───────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50">

      {/* ── Header ────────────────────────────────────────── */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-50 h-16 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 md:px-8 h-full flex items-center justify-between">

          {/* Brand */}
          <div>
            <h1 className="text-lg font-extrabold text-[#1e3a5f] tracking-tight leading-none">
              CertLingo
            </h1>
            <p className="text-[11px] text-slate-400 font-medium tracking-wide">
              Processing Dashboard
            </p>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {/* Backend status dot */}
            <span className="hidden sm:flex items-center gap-1.5 text-xs">
              <span
                className={`w-2 h-2 rounded-full transition-colors ${
                  backendOnline ? "bg-emerald-400" : "bg-slate-300"
                }`}
              />
              <span className={backendOnline ? "text-emerald-600" : "text-slate-400"}>
                {backendOnline ? "Backend online" : "Backend offline"}
              </span>
            </span>

            {/* Open question bank */}
            <a
              // page.tsx
              href="https://certlingo-question-bank.vercel.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="px-3 py-1.5 rounded-lg bg-amber-500 text-slate-900 text-xs font-bold hover:bg-amber-400 transition-colors"
            >
              Open Question Bank →
            </a>
          </div>
        </div>
      </header>

      {/* ── Main ──────────────────────────────────────────── */}
      <main className="max-w-7xl mx-auto px-4 md:px-8 py-8 space-y-8">

        {/* Page title */}
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-slate-400">
            Workflow
          </p>
          <h2 className="mt-1 text-2xl font-extrabold text-slate-800 tracking-tight">
            Question Bank Pipeline
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Import a video, extract and process questions, load into your database, and publish.
          </p>
        </div>

        {/* Four-chevron nav */}
        <ChevronNav
          steps={steps}
          currentStep={currentStep}
          onStepClick={setCurrentStep}
        />

        {/* Active step content */}
        <div className="min-h-[400px]">

          {/* Step 1 — Import */}
          {currentStep === 1 && (
            <StepImport
              onStatusChange={(s) => setStepStatus(1, s)}
              onComplete={(shots) => {
                setScreenshots(shots);
                advanceToStep(2);
              }}
            />
          )}

          {/* Step 2 — Process */}
          {currentStep === 2 && (
            <StepProcess
              screenshots={screenshots}
              onStatusChange={(s) => setStepStatus(2, s)}
              onComplete={(path) => {
                setCsvPath(path);
                advanceToStep(3);
              }}
            />
          )}

          {/* Step 3 — Load */}
          {currentStep === 3 && (
            <StepLoad
              csvPath={csvPath}
              onStatusChange={(s) => setStepStatus(3, s)}
              onComplete={() => advanceToStep(4)}
            />
          )}

          {/* Step 4 — Publish */}
          {currentStep === 4 && <StepPublish />}

        </div>

        {/* Footer */}
        <footer className="border-t border-slate-200 pt-6 text-center">
          <p className="text-xs text-slate-400">
            CertLingo Processing Dashboard &nbsp;·&nbsp; Local build &nbsp;·&nbsp;
            Backend: <span className="font-mono">localhost:8000</span>
          </p>
        </footer>

      </main>
    </div>
  );
}