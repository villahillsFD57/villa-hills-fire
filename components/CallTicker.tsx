"use client";

import { useEffect, useState, useCallback, useRef } from "react";

interface Call {
  id: string;
  dispatchDate: string;
  dispatchTime: string;
  dispatchNature: string;
  dispatchDatetime: string;
  sourceYear: number;
}

interface Summary {
  latest: Call | null;
  count: number | null;
  countComplete?: boolean;
  year: number;
  updatedAt: string;
}

const POLL_INTERVAL = 30_000;
const REQUEST_TIMEOUT = 15_000;
const CHICAGO = "America/Chicago";

function isCall(value: unknown): value is Call {
  if (!value || typeof value !== "object") return false;
  const call = value as Record<string, unknown>;
  return ["id", "dispatchDate", "dispatchTime", "dispatchNature", "dispatchDatetime"]
    .every(key => typeof call[key] === "string")
    && Number.isFinite(Date.parse(call.dispatchDatetime as string))
    && Number.isInteger(call.sourceYear);
}

function isSummary(value: unknown): value is Summary {
  if (!value || typeof value !== "object") return false;
  const summary = value as Record<string, unknown>;
  return (summary.latest === null || isCall(summary.latest))
    && (summary.count === null || (typeof summary.count === "number" && Number.isInteger(summary.count) && summary.count >= 0))
    && (summary.countComplete === undefined || typeof summary.countComplete === "boolean")
    && Number.isInteger(summary.year)
    && typeof summary.updatedAt === "string" && Number.isFinite(Date.parse(summary.updatedAt));
}

function shortDate(date: string): string {
  return date.slice(0, 5); // "04/04"
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", { timeZone: CHICAGO, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { timeZone: CHICAGO, weekday: "short", month: "short", day: "numeric" });
}

export default function CallTicker() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [allCalls, setAllCalls] = useState<Call[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [summaryError, setSummaryError] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState(false);
  const [lastChecked, setLastChecked] = useState<number | null>(null);
  const [now, setNow] = useState<Date>(new Date());
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const summaryRequest = useRef<AbortController | null>(null);
  const logRequest = useRef<AbortController | null>(null);

  const fetchSummary = useCallback(async () => {
    if (document.visibilityState !== "visible" || summaryRequest.current) return;
    if (!navigator.onLine) {
      setSummaryError(true);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    summaryRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const res = await fetch("/api/cad/summary", { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error("Call updates unavailable");
      const data: unknown = await res.json();
      if (!isSummary(data)) throw new Error("Invalid call summary");
      if (mounted.current && summaryRequest.current === controller) {
        setSummary(data);
        setSummaryError(false);
        setLastChecked(Date.now());
      }
    } catch {
      if (mounted.current && summaryRequest.current === controller) setSummaryError(true);
    } finally {
      clearTimeout(timeout);
      if (summaryRequest.current === controller) {
        summaryRequest.current = null;
        if (mounted.current) setLoading(false);
      }
    }
  }, []);

  const fetchAll = useCallback(async () => {
    if (document.visibilityState !== "visible" || logRequest.current) return;
    const controller = new AbortController();
    logRequest.current = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    setLogLoading(true);
    try {
      const res = await fetch("/api/cad/log", { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error("Call log unavailable");
      const calls: unknown = await res.json();
      if (!Array.isArray(calls) || !calls.every(isCall)) throw new Error("Invalid call log");
      if (mounted.current && logRequest.current === controller) {
        setAllCalls(calls);
        setLogError(false);
      }
    } catch {
      if (mounted.current && logRequest.current === controller) setLogError(true);
    } finally {
      clearTimeout(timeout);
      if (logRequest.current === controller) {
        logRequest.current = null;
        if (mounted.current) setLogLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { void fetchSummary(); };
    const offline = () => { setSummaryError(true); };
    refresh();
    const pollId = setInterval(refresh, POLL_INTERVAL);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("offline", offline);
    return () => {
      mounted.current = false;
      clearInterval(pollId);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", offline);
      summaryRequest.current?.abort();
      logRequest.current?.abort();
      summaryRequest.current = null;
      logRequest.current = null;
    };
  }, [fetchSummary]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // The full yearly log is downloaded only when someone opens it, or while
  // it is open and the shared summary changes. Collapsed tickers never fetch it.
  useEffect(() => {
    if (!expanded) return;
    const refresh = () => { void fetchAll(); };
    refresh();
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
    };
  }, [expanded, summary?.updatedAt, fetchAll]);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setExpanded(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [expanded]);

  const currentYear = Number(now.toLocaleDateString("en-US", { timeZone: CHICAGO, year: "numeric" }));
  const countComplete = summary?.countComplete === true && summary.year === currentYear && summary.count !== null;
  const callCount = countComplete ? summary.count : null;
  const historyIncomplete = summary !== null && !countComplete;
  const yearCalls = allCalls?.filter(call => call.sourceYear === currentYear) ?? [];
  const lastCall = summary?.latest ?? null;
  const unavailable = summaryError
    || (lastChecked !== null && now.getTime() - lastChecked > POLL_INTERVAL * 3)
    || (summary !== null && now.getTime() - Date.parse(summary.updatedAt) > 65 * 60 * 1000);
  const elapsed = lastCall ? now.getTime() - Date.parse(lastCall.dispatchDatetime) : NaN;
  const isActive = !unavailable && Number.isFinite(elapsed) && elapsed >= 0 && elapsed < 2 * 60 * 60 * 1000;
  const statusLabel = unavailable ? "Updates unavailable" : loading ? "Loading" : isActive ? "Active Call" : lastCall ? "Last Call" : historyIncomplete ? "Awaiting updates" : "In Service";

  return (
    <div ref={wrapperRef} className="fixed top-0 left-0 right-0" style={{ zIndex: 60 }}>

      {/* -- Expanded call log panel -- */}
      {expanded && (
        <div
          className="bg-[#0a0a0a]/98 backdrop-blur-md border-b border-white/10 shadow-2xl shadow-black/60"
          style={{ maxHeight: "60vh", overflowY: "auto" }}
        >
          <div className="wrap py-4">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <span className="h-px w-5 bg-[#8B0000]" />
                <span className="text-[#dc2626] text-xs font-black tracking-[0.2em] uppercase">
                  {currentYear} Dispatch Log
                </span>
              </div>
              <span className="text-gray-600 text-xs">
                {countComplete ? `${callCount} calls this year` : "Annual total unavailable"}
              </span>
            </div>

            {historyIncomplete && (
              <p className="text-amber-400 text-sm mb-3">Earlier call records are unavailable. This list may be incomplete.</p>
            )}
            {logError && (
              <p role="status" className="text-amber-400 text-sm mb-3">
                Call log unavailable. {allCalls !== null ? "Showing the last loaded log. " : ""}
                <button className="underline" onClick={() => void fetchAll()}>Retry</button>
              </p>
            )}
            {allCalls === null ? (
              <div className="py-8 text-center text-gray-500 text-sm">{logLoading ? "Loading call log…" : "Call log has not loaded."}</div>
            ) : yearCalls.length === 0 ? (
              <div className="py-8 text-center text-gray-500 text-sm">{historyIncomplete ? "No call records are currently available." : "No calls logged yet for this year."}</div>
            ) : (
              <div className="divide-y divide-white/5">
                {yearCalls.map((call) => (
                  <div key={call.id} className="flex items-center gap-3 py-3 px-1">
                    <span className="w-2 h-2 rounded-full shrink-0 bg-red-500/70" />
                    <span className="text-gray-500 text-xs tabular-nums w-20 shrink-0">{call.dispatchDate}</span>
                    <span className="text-gray-400 text-xs tabular-nums w-12 shrink-0 font-mono">{call.dispatchTime}</span>
                    <span className="text-xs font-bold uppercase tracking-wide truncate text-gray-300">
                      {call.dispatchNature}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <p className="text-gray-700 text-[10px] mt-4 pt-3 border-t border-white/5">
              Displaying dispatch nature only. Times in Central Time. Log resets January 1.
            </p>
          </div>
        </div>
      )}

      {/* -- Ticker strip -- */}
      <div className="bg-[#0d0d0d] border-b border-[rgba(139,0,0,0.4)] select-none" style={{ height: "40px" }}>
        <div className="h-full wrap flex items-center gap-2 text-[0.65rem] font-mono tracking-widest uppercase">

          {/* -- Status dot + label -- */}
          <div className="shrink-0 flex items-center gap-1.5">
            <span className="relative flex w-2 h-2">
              {isActive && (
                <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping bg-red-500" />
              )}
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  unavailable ? "bg-amber-500" : (loading || (historyIncomplete && !lastCall)) ? "bg-gray-500" : isActive ? "bg-red-500" : lastCall ? "bg-red-900" : "bg-green-500"
                }`}
              />
            </span>
            <span
              className={`text-[10px] font-black tracking-wider uppercase whitespace-nowrap ${
                unavailable ? "text-amber-400" : (loading || (historyIncomplete && !lastCall)) ? "text-gray-500" : isActive ? "text-red-400" : lastCall ? "text-gray-500" : "text-green-600"
              }`}
            >
              {statusLabel}
            </span>
          </div>

          <span className="h-3 w-px bg-white/15 shrink-0" />

          {/* -- Call info -- */}
          <div className="flex-1 min-w-0 overflow-hidden">
            {lastCall ? (
              <div className="flex items-center gap-1.5 min-w-0" title={unavailable ? "Last known call; updates are unavailable" : undefined}>
                {unavailable && <span className="text-amber-400 text-[10px] shrink-0 hidden sm:inline">Last known</span>}
                <span className="text-gray-500 text-[10px] whitespace-nowrap shrink-0">@</span>
                <span className="text-white font-bold tabular-nums font-mono text-[10px] whitespace-nowrap shrink-0">
                  {shortDate(lastCall.dispatchDate)} {lastCall.dispatchTime}
                </span>
                <span className="text-white/20 shrink-0">&middot;</span>
                <span className={`font-bold text-[11px] truncate ${isActive ? "text-red-400" : "text-gray-400"}`}>{lastCall.dispatchNature}</span>
              </div>
            ) : (
              <span className="text-gray-500 text-[10px]">{unavailable ? "Please check back shortly." : loading ? "Checking call updates…" : historyIncomplete ? "Earlier call history unavailable." : "No calls logged."}</span>
            )}
          </div>

          {/* -- Call count tracker -- */}
          <div className="shrink-0 flex items-center gap-2 border border-white/10 rounded-full px-3 py-1 bg-white/5 text-[10px] text-gray-300 min-w-[72px]">
            <span className="text-gray-500 uppercase tracking-[0.2em]">Calls</span>
            <span className="font-black tabular-nums text-white" title={historyIncomplete ? "Annual total unavailable while earlier call records are missing" : undefined} aria-label={historyIncomplete ? "Annual total unavailable" : undefined}>{callCount ?? "—"}</span>
          </div>

          <span className="h-3 w-px bg-white/15 shrink-0" />
          <div className="shrink-0 items-center gap-1.5 hidden md:flex">
            <span className="text-gray-600 text-[10px] tabular-nums font-mono" suppressHydrationWarning>{formatDate(now)}</span>
            <span style={{ color: "#8B0000", fontWeight: 700 }} className="text-[10px] tabular-nums font-mono" suppressHydrationWarning>{formatClock(now)}</span>
          </div>

          {/* -- Expand toggle -- */}
          <button
            onClick={() => setExpanded(v => !v)}
            className="shrink-0 flex items-center gap-1 px-3 py-1 rounded-full bg-[#8B0000]/10 hover:bg-[#8B0000]/15 border border-white/10 text-gray-300 hover:text-white transition-colors text-[10px] font-bold"
            aria-label={expanded ? "Collapse call log" : "View call log"}
          >
            <span className="hidden sm:inline">{expanded ? "Hide Call Log" : "View Call Log"}</span>
            <svg viewBox="0 0 24 24" className={`w-3 h-3 fill-current transition-transform ${expanded ? "rotate-180" : ""}`}>
              <path d="M7 14l5-5 5 5H7z" />
            </svg>
          </button>

        </div>
      </div>

      {/* -- Disclaimer bar -- only visible when log is expanded -- */}
      {expanded && (
        <div className="bg-[#080808] border-b border-white/5 py-0.5 text-center select-none">
          <span className="text-gray-600 text-[9px] tracking-wide">
            {countComplete ? <><span className="font-bold text-gray-500">{callCount}</span> calls logged {currentYear}</> : "Annual call total unavailable"}
          </span>
        </div>
      )}

    </div>
  );
}
