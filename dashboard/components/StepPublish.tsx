"use client";

export default function StepPublish() {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm space-y-4">
      <div>
        <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest">
          Publish Question Bank
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Connect processed questions to the CertLingo quiz platform
        </p>
      </div>
      <div className="rounded-xl border-2 border-dashed border-slate-200 p-10 text-center">
        <div className="w-12 h-12 rounded-2xl bg-amber-50 flex items-center justify-center mx-auto mb-3">
          <svg className="w-6 h-6 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
          </svg>
        </div>
        <p className="text-sm font-semibold text-slate-500">CertLingo platform connection</p>
        <p className="text-xs text-slate-400 mt-1">Publishing pipeline — Stage 7</p>
      </div>
    </div>
  );
}