"use client";

export type StepStatus = "idle" | "active" | "done" | "error";

export interface Step {
  id: number;
  label: string;
  sublabel: string;
  icon: string;
  status: StepStatus;
}

interface ChevronNavProps {
  steps: Step[];
  currentStep: number;
  onStepClick: (id: number) => void;
}

const statusColors: Record<StepStatus, string> = {
  idle:   "bg-slate-100 text-slate-400 border-slate-200",
  active: "bg-[#1e3a5f] text-white border-[#1e3a5f] shadow-lg shadow-blue-900/20",
  done:   "bg-emerald-50 text-emerald-700 border-emerald-200",
  error:  "bg-rose-50 text-rose-700 border-rose-200",
};

const iconColors: Record<StepStatus, string> = {
  idle:   "bg-slate-200 text-slate-400",
  active: "bg-white/20 text-white",
  done:   "bg-emerald-100 text-emerald-600",
  error:  "bg-rose-100 text-rose-500",
};

const statusDot: Record<StepStatus, string> = {
  idle:   "bg-slate-300",
  active: "bg-amber-400 animate-pulse",
  done:   "bg-emerald-400",
  error:  "bg-rose-500",
};

export default function ChevronNav({
  steps,
  currentStep,
  onStepClick,
}: ChevronNavProps) {
  return (
    <nav className="w-full">
      <div className="flex items-stretch">
        {steps.map((step, index) => {
          const isLast = index === steps.length - 1;
          const isClickable =
            step.status === "done" || step.id === currentStep;

          return (
            <div key={step.id} className="flex items-stretch flex-1 min-w-0">

              {/* Chevron card */}
              <button
                onClick={() => isClickable && onStepClick(step.id)}
                disabled={!isClickable && step.status === "idle"}
                className={`
                  relative flex items-center gap-3 px-4 py-4 w-full
                  border-2 rounded-none transition-all duration-200
                  ${statusColors[step.status]}
                  ${isClickable ? "cursor-pointer hover:brightness-95" : "cursor-default"}
                  ${index === 0 ? "rounded-l-2xl" : ""}
                  ${isLast ? "rounded-r-2xl" : ""}
                `}
              >
                {/* Step number icon */}
                <div
                  className={`
                    w-9 h-9 rounded-xl flex items-center justify-center
                    text-sm font-bold shrink-0 transition-all
                    ${iconColors[step.status]}
                  `}
                >
                  {step.status === "done" ? (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : step.status === "error" ? (
                    <span>!</span>
                  ) : (
                    <span>{step.id}</span>
                  )}
                </div>

                {/* Labels */}
                <div className="text-left min-w-0 hidden sm:block">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-bold uppercase tracking-widest opacity-60 truncate">
                      Step {step.id}
                    </p>
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusDot[step.status]}`} />
                  </div>
                  <p className="text-sm font-bold leading-tight truncate">{step.label}</p>
                  <p className="text-[11px] opacity-60 truncate">{step.sublabel}</p>
                </div>
              </button>

              {/* Connector arrow between steps */}
              {!isLast && (
                <div className="flex items-center shrink-0 -mx-px z-10">
                  <svg
                    className="w-5 h-full"
                    viewBox="0 0 20 60"
                    preserveAspectRatio="none"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M0 0 L20 30 L0 60"
                      fill={step.status === "active" ? "#1e3a5f" : step.status === "done" ? "#d1fae5" : "#f1f5f9"}
                      stroke={step.status === "active" ? "#1e3a5f" : "#e2e8f0"}
                      strokeWidth="1"
                    />
                  </svg>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </nav>
  );
}