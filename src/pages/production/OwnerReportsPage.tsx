import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { db, functions } from '../../firebase';
import { collection, getDocs } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { BarChart3, Loader2, Printer, IndianRupee, Clock, Users, AlertTriangle } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { can } from '../../utils/rolePermissions';

type TabKey = 'production' | 'karigar' | 'labour' | 'reworkReject';

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Always DD/MM/YYYY — never locale-dependent (per spec). */
function fmtDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}
/** HH:MM, 24-hour. */
function fmtTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDateTime(iso?: string | null): string {
  if (!iso) return '—';
  return `${fmtDate(iso)} ${fmtTime(iso)}`;
}
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function daysAgoYmd(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

interface PeriodCard { totalLabourMinutes: number; totalLabourCost: number; completedSessions: number; piecesWorked: number; }
interface KarigarSummary {
  karigarId: string; name: string; piecesWorked: number; totalMinutes: number; totalLabourCost: number;
  firstStartAt: string | null; lastEndAt: string | null; avgMinutesPerPiece: number; reworkPieces: number;
}
interface SummaryResponse {
  periods: { today: PeriodCard; yesterday: PeriodCard; last7Days: PeriodCard; currentMonth: PeriodCard };
  karigars: KarigarSummary[];
  performance: {
    piecesCompletedToday: number; piecesCompletedYesterday: number; piecesCompletedLast7Days: number; piecesCompletedCurrentMonth: number;
    reworkCount: number; rejectCount: number; averageLabourCostPerPiece: number;
  };
}
interface KarigarReportRow {
  sessionId: string; karigarId: string; karigarName: string; pieceId: string; designId: string | null; designName: string | null;
  type: string; startedAt: string; endedAt: string | null; minutes: number; hourlyRate: number; labourCost: number;
}
interface KarigarReportResponse {
  rows: KarigarReportRow[];
  dailyTotals: { date: string; totalMinutes: number; totalLabourCost: number; pieceCount: number }[];
  totals: { totalPieces: number; totalMinutes: number; totalLabourCost: number; reworkPieces: number; averageMinutesPerPiece: number };
}

function PeriodKpi({ title, card }: { title: string; card: PeriodCard }) {
  return (
    <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
      <h3 className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">{title}</h3>
      <div className="grid grid-cols-2 gap-3">
        <div><p className="text-xl font-display text-black">{card.totalLabourMinutes}</p><p className="text-[9px] text-gray-400 uppercase">Minutes</p></div>
        <div><p className="text-xl font-display text-black">₹{card.totalLabourCost.toFixed(2)}</p><p className="text-[9px] text-gray-400 uppercase">Cost</p></div>
        <div><p className="text-sm font-medium text-gray-600">{card.completedSessions}</p><p className="text-[9px] text-gray-400 uppercase">Sessions</p></div>
        <div><p className="text-sm font-medium text-gray-600">{card.piecesWorked}</p><p className="text-[9px] text-gray-400 uppercase">Pieces</p></div>
      </div>
    </div>
  );
}

/**
 * Owner/Super Admin Production Reports — Production Report, Karigar
 * Production Report, Labour Cost Report, Rework/Reject Report.
 * Gated by the EXISTING 'production.reports' permission (super_admin/owner
 * only — admin already has it today via can()'s own non-strict-module
 * bypass, not newly granted here). All labour figures come from the
 * server-side ownerLabourSummary/karigarProductionReport callables
 * (functions/src/reports.ts) — this page never reads pieceWorkSessions
 * directly from the browser.
 */
export default function OwnerReportsPage() {
  const { user } = useAuth();
  const effectiveRole = (user?.staffRole || user?.role || '') as any;
  const canView = can(effectiveRole, 'production.reports');

  const [tab, setTab] = useState<TabKey>('production');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [pieces, setPieces] = useState<any[]>([]);

  const [karigarId, setKarigarId] = useState('');
  const [startDate, setStartDate] = useState(daysAgoYmd(30));
  const [endDate, setEndDate] = useState(todayYmd());
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [report, setReport] = useState<KarigarReportResponse | null>(null);

  const loadBaseline = useCallback(async () => {
    if (!canView) { setLoading(false); return; }
    setLoading(true);
    setError(null);
    try {
      const [summaryRes, piecesSnap] = await Promise.all([
        httpsCallable(functions, 'ownerLabourSummary')({}) as Promise<any>,
        getDocs(collection(db, 'pieces')),
      ]);
      setSummary(summaryRes?.data || null);
      setPieces(piecesSnap.docs.map((d) => d.data()));
    } catch (err: any) {
      setError(err?.message || 'Failed to load reports.');
    } finally {
      setLoading(false);
    }
  }, [canView]);

  useEffect(() => { loadBaseline(); }, [loadBaseline]);

  const runKarigarReport = useCallback(async () => {
    setReportLoading(true);
    setReportError(null);
    try {
      const res: any = await httpsCallable(functions, 'karigarProductionReport')({
        karigarId: karigarId || undefined, startDate, endDate,
      });
      setReport(res?.data || null);
    } catch (err: any) {
      setReportError(err?.message || 'Failed to load the Karigar Production Report.');
    } finally {
      setReportLoading(false);
    }
  }, [karigarId, startDate, endDate]);

  useEffect(() => { if (canView && tab === 'karigar') runKarigarReport(); }, [canView, tab, runKarigarReport]);

  const reworkRejectRows = useMemo(() => {
    return pieces
      .filter((p) => p.stage === 'REJECTED' || (Number(p.reworkCount) || 0) > 0)
      .map((p) => ({
        pieceId: p.id, designId: p.designId || '—', stage: p.stage, reworkCount: Number(p.reworkCount) || 0,
        rejectionType: p.rejectionType || null, rejectionReason: p.rejectionReason || null,
        rejectedByName: p.rejectedByName || null, rejectedAt: p.rejectedAt || null,
      }))
      .sort((a, b) => String(b.rejectedAt || '').localeCompare(String(a.rejectedAt || '')));
  }, [pieces]);

  const karigarOptions = summary?.karigars || [];
  const selectedKarigarName = karigarOptions.find((k) => k.karigarId === karigarId)?.name || 'All Karigars';

  if (!canView) {
    return (
      <div className="text-center py-20">
        <p className="text-sm text-gray-500">You do not have permission to view Production Reports.</p>
      </div>
    );
  }

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'production', label: 'Production Report' },
    { key: 'karigar', label: 'Karigar Production Report' },
    { key: 'labour', label: 'Labour Cost Report' },
    { key: 'reworkReject', label: 'Rework / Reject Report' },
  ];

  return (
    // print:min-h-0 — the bug fix. min-h-screen forces min-height:100vh,
    // which in print is computed against the physical page box BEFORE
    // Chrome's own header/footer margins are subtracted, so it is
    // fractionally taller than one printable page — pushing a completely
    // empty sliver onto a second, blank page for every short report. The
    // print variant removes the forced height so the box sizes to its
    // actual content; a genuinely long report still paginates normally
    // since nothing here caps how TALL the content may grow.
    <div className="min-h-screen print:min-h-0 p-6 md:p-8">
      <div className="mb-8 print:hidden">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-black text-white rounded-xl flex items-center justify-center">
            <BarChart3 size={18} />
          </div>
          <div>
            <h1 className="text-2xl font-display text-black tracking-wide">Production Reports</h1>
            <p className="text-xs text-gray-500 font-sans mt-1">Owner / Super Admin{loading && ' · loading…'}</p>
          </div>
        </div>
      </div>

      {error && <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 text-red-600 text-xs print:hidden">{error}</div>}

      {loading ? (
        <div className="flex items-center justify-center py-24 print:hidden"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 mb-6 print:hidden">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-colors ${tab === t.key ? 'bg-black text-white' : 'bg-gray-50 text-gray-600 hover:bg-gray-100'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'production' && summary && (
            <div className="space-y-6">
              <ReportPrintHeader title="Production Report" subtitle={<p className="text-sm">{fmtDate(new Date().toISOString())}</p>} />
              <div className="flex justify-end print:hidden"><ExportPdfButton /></div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <KpiMini label="Completed Today" value={summary.performance.piecesCompletedToday} />
                <KpiMini label="Completed Yesterday" value={summary.performance.piecesCompletedYesterday} />
                <KpiMini label="Completed Last 7 Days" value={summary.performance.piecesCompletedLast7Days} />
                <KpiMini label="Completed This Month" value={summary.performance.piecesCompletedCurrentMonth} />
                <KpiMini label="Rework Pieces" value={summary.performance.reworkCount} accent="orange" />
                <KpiMini label="Rejected Pieces" value={summary.performance.rejectCount} accent="red" />
                <KpiMini label="Avg Labour Cost / Piece" value={`₹${summary.performance.averageLabourCostPerPiece.toFixed(2)}`} />
              </div>
            </div>
          )}

          {tab === 'labour' && summary && (
            <div className="space-y-6">
              <ReportPrintHeader title="Labour Cost Report" subtitle={<p className="text-sm">{fmtDate(new Date().toISOString())}</p>} />
              <div className="flex justify-end print:hidden"><ExportPdfButton /></div>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <PeriodKpi title="Today" card={summary.periods.today} />
                <PeriodKpi title="Yesterday" card={summary.periods.yesterday} />
                <PeriodKpi title="Last 7 Days" card={summary.periods.last7Days} />
                <PeriodKpi title="Current Month" card={summary.periods.currentMonth} />
              </div>
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden print:border-0 print:shadow-none print:rounded-none">
                <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2 print:hidden">
                  <Users size={16} className="text-gray-400" />
                  <h2 className="text-sm font-bold text-black uppercase tracking-widest">Karigar Summary (all-time)</h2>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-100">
                      {['Karigar', 'Pieces', 'Minutes', 'Cost', 'First Start', 'Last End', 'Avg Min/Piece', 'Rework'].map((h) => (
                        <th key={h} className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {karigarOptions.map((k) => (
                        <tr key={k.karigarId} className="border-b border-gray-50">
                          <td className="px-4 py-3 font-medium text-black">{k.name}</td>
                          <td className="px-4 py-3 font-mono">{k.piecesWorked}</td>
                          <td className="px-4 py-3 font-mono">{k.totalMinutes}</td>
                          <td className="px-4 py-3 font-mono">₹{k.totalLabourCost.toFixed(2)}</td>
                          <td className="px-4 py-3 font-mono text-xs">{fmtDateTime(k.firstStartAt)}</td>
                          <td className="px-4 py-3 font-mono text-xs">{fmtDateTime(k.lastEndAt)}</td>
                          <td className="px-4 py-3 font-mono">{k.avgMinutesPerPiece}</td>
                          <td className="px-4 py-3 font-mono">{k.reworkPieces}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {tab === 'reworkReject' && (
            <div>
              <ReportPrintHeader title="Rework / Reject Report" subtitle={<p className="text-sm">{fmtDate(new Date().toISOString())}</p>} />
              <div className="flex justify-end mb-4 print:hidden"><ExportPdfButton /></div>
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden print:border-0 print:shadow-none print:rounded-none">
              <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2 print:hidden">
                <AlertTriangle size={16} className="text-gray-400" />
                <h2 className="text-sm font-bold text-black uppercase tracking-widest">Rework / Reject Report</h2>
              </div>
              {reworkRejectRows.length === 0 ? (
                <div className="text-center py-12"><p className="text-sm text-gray-500">No rework or rejected pieces yet.</p></div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-b border-gray-100">
                      {['Piece', 'Design', 'Stage', 'Reworks', 'Rejection Type', 'Reason', 'By', 'At'].map((h) => (
                        <th key={h} className="text-left px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-gray-400">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {reworkRejectRows.map((r) => (
                        <tr key={r.pieceId} className="border-b border-gray-50">
                          <td className="px-4 py-3 font-mono text-xs">{r.pieceId}</td>
                          <td className="px-4 py-3 font-mono text-xs">{r.designId}</td>
                          <td className="px-4 py-3 text-xs">{r.stage}</td>
                          <td className="px-4 py-3 font-mono">{r.reworkCount}</td>
                          <td className="px-4 py-3 text-xs">{r.rejectionType || '—'}</td>
                          <td className="px-4 py-3 text-xs text-gray-600 max-w-xs truncate" title={r.rejectionReason || ''}>{r.rejectionReason || '—'}</td>
                          <td className="px-4 py-3 text-xs">{r.rejectedByName || '—'}</td>
                          <td className="px-4 py-3 font-mono text-xs">{fmtDateTime(r.rejectedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              </div>
            </div>
          )}

          {tab === 'karigar' && (
            <>
              <div className="bg-white border border-gray-200 rounded-2xl shadow-sm p-6 mb-6 print:hidden">
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">Karigar</label>
                    <select value={karigarId} onChange={(e) => setKarigarId(e.target.value)} className="text-xs border border-gray-200 rounded-lg px-3 py-2 min-w-[160px]">
                      <option value="">All Karigars</option>
                      {karigarOptions.map((k) => <option key={k.karigarId} value={k.karigarId}>{k.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">Start Date</label>
                    <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="text-xs border border-gray-200 rounded-lg px-3 py-2" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-1">End Date</label>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="text-xs border border-gray-200 rounded-lg px-3 py-2" />
                  </div>
                  <button onClick={runKarigarReport} disabled={reportLoading} className="px-4 py-2 bg-black text-white rounded-lg text-[10px] font-bold uppercase tracking-widest disabled:opacity-40">
                    {reportLoading ? 'Loading…' : 'Run Report'}
                  </button>
                  {report && (
                    <button onClick={() => window.print()} className="flex items-center gap-1.5 px-4 py-2 border border-gray-200 rounded-lg text-[10px] font-bold uppercase tracking-widest text-gray-700 hover:bg-gray-50">
                      <Printer size={12} /> Export PDF
                    </button>
                  )}
                </div>
                {reportError && <p className="mt-3 text-xs text-red-500">{reportError}</p>}
              </div>

              {reportLoading ? (
                <div className="flex items-center justify-center py-24 print:hidden"><Loader2 className="w-6 h-6 animate-spin text-gray-400" /></div>
              ) : report && (
                <div id="karigar-report-print">
                  <ReportPrintHeader
                    title="Karigar Production Report"
                    subtitle={<>
                      <p className="text-sm">{selectedKarigarName}</p>
                      <p className="text-sm">{fmtDate(`${startDate}T00:00:00.000Z`)} – {fmtDate(`${endDate}T00:00:00.000Z`)}</p>
                    </>}
                  />

                  <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden print:border-0 print:shadow-none print:rounded-none">
                    <div className="px-6 py-4 border-b border-gray-100 flex items-center gap-2 print:hidden">
                      <Clock size={16} className="text-gray-400" />
                      <h2 className="text-sm font-bold text-black uppercase tracking-widest">Sessions — {selectedKarigarName}</h2>
                    </div>
                    {report.rows.length === 0 ? (
                      <div className="text-center py-12 print:hidden"><p className="text-sm text-gray-500">No completed sessions in this range.</p></div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm print:text-xs">
                          <thead><tr className="border-b border-gray-200">
                            {['Date', 'Piece', 'Design', 'Type', 'Start', 'End', 'Minutes', 'Rate', 'Cost'].map((h) => (
                              <th key={h} className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">{h}</th>
                            ))}
                          </tr></thead>
                          <tbody>
                            {report.rows.map((r) => (
                              <tr key={r.sessionId} className="border-b border-gray-50">
                                <td className="px-3 py-2 font-mono">{fmtDate(r.startedAt)}</td>
                                <td className="px-3 py-2 font-mono">{r.pieceId}</td>
                                <td className="px-3 py-2 font-mono">{r.designName || r.designId || '—'}</td>
                                <td className="px-3 py-2">{r.type}</td>
                                <td className="px-3 py-2 font-mono">{fmtTime(r.startedAt)}</td>
                                <td className="px-3 py-2 font-mono">{fmtTime(r.endedAt)}</td>
                                <td className="px-3 py-2 font-mono">{r.minutes}</td>
                                <td className="px-3 py-2 font-mono">₹{r.hourlyRate}</td>
                                <td className="px-3 py-2 font-mono">₹{r.labourCost.toFixed(2)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>

                  {report.dailyTotals.length > 0 && (
                    <div className="bg-white border border-gray-200 rounded-2xl shadow-sm overflow-hidden mt-4 print:border-0 print:shadow-none print:rounded-none print:mt-2">
                      <div className="px-6 py-3 border-b border-gray-100 print:hidden"><h3 className="text-xs font-bold uppercase tracking-widest text-gray-500">Daily Totals</h3></div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm print:text-xs">
                          <thead><tr className="border-b border-gray-100">
                            {['Date', 'Minutes', 'Cost', 'Pieces'].map((h) => <th key={h} className="text-left px-3 py-2 text-[10px] font-bold uppercase tracking-widest text-gray-400">{h}</th>)}
                          </tr></thead>
                          <tbody>
                            {report.dailyTotals.map((d) => (
                              <tr key={d.date} className="border-b border-gray-50">
                                <td className="px-3 py-2 font-mono">{fmtDate(`${d.date}T00:00:00.000Z`)}</td>
                                <td className="px-3 py-2 font-mono">{d.totalMinutes}</td>
                                <td className="px-3 py-2 font-mono">₹{d.totalLabourCost.toFixed(2)}</td>
                                <td className="px-3 py-2 font-mono">{d.pieceCount}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  <div className="bg-black text-white rounded-2xl shadow-sm p-6 mt-4 print:bg-white print:text-black print:border print:border-black print:rounded-none">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-white/60 print:text-black mb-4 flex items-center gap-2"><IndianRupee size={14} /> Summary</h3>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                      <SummaryStat label="Total Pieces" value={report.totals.totalPieces} />
                      <SummaryStat label="Total Minutes" value={report.totals.totalMinutes} />
                      <SummaryStat label="Total Labour Cost" value={`₹${report.totals.totalLabourCost.toFixed(2)}`} />
                      <SummaryStat label="Rework Pieces" value={report.totals.reworkPieces} />
                      <SummaryStat label="Avg Minutes/Piece" value={report.totals.averageMinutesPerPiece} />
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function KpiMini({ label, value, accent }: { label: string; value: React.ReactNode; accent?: 'orange' | 'red' }) {
  const color = accent === 'orange' ? 'text-orange-600' : accent === 'red' ? 'text-red-500' : 'text-black';
  return (
    <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
      <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2">{label}</p>
      <p className={`text-2xl font-display ${color}`}>{value}</p>
    </div>
  );
}

/** Print-only document header — shown only when printing/exporting, never on screen. */
function ReportPrintHeader({ title, subtitle }: { title: string; subtitle?: React.ReactNode }) {
  return (
    <div className="hidden print:block mb-6">
      <h1 className="text-2xl font-bold">LUXARDO FASHION</h1>
      <h2 className="text-lg">{title}</h2>
      {subtitle}
    </div>
  );
}

/** "Export PDF" — a plain window.print() (see index.css's @media print block for the layout fix). Never shown in print itself. */
function ExportPdfButton() {
  return (
    <button onClick={() => window.print()} className="flex items-center gap-1.5 px-4 py-2 border border-gray-200 rounded-lg text-[10px] font-bold uppercase tracking-widest text-gray-700 hover:bg-gray-50 print:hidden">
      <Printer size={12} /> Export PDF
    </button>
  );
}

function SummaryStat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-2xl font-display">{value}</p>
      <p className="text-[10px] text-white/50 print:text-gray-500 uppercase tracking-widest mt-1">{label}</p>
    </div>
  );
}
