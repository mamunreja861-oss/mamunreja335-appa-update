import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Printer, Trash2, Check, X, ShieldCheck, Search } from 'lucide-react';
import { UserProfile } from '../../modules/types';
import { ReportArchiveItem, ReportAuditLogItem, reportApi } from '../../services/reportApi';
import { useCloudSync } from '../../services/cloudSync';
import { extractFriendlyErrorMessage } from '../../services/firebase';
import {
  saveReportArchiveToFirestore,
  saveReportAuditLogToFirestore,
  subscribeReportArchivesFromFirestore,
  subscribeReportAuditLogsFromFirestore,
} from '../../services/reportFirestore';
import { Button } from '../../components/Button';

interface ReportArchiveAuditPageProps {
  currentUser: UserProfile;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

export const ReportArchiveAuditPage: React.FC<ReportArchiveAuditPageProps> = ({
  currentUser,
  onShowToast,
}) => {
  const cloudSync = useCloudSync();
  const [tab, setTab] = useState<'archives' | 'audit'>('archives');
  const [baseArchives, setBaseArchives] = useState<ReportArchiveItem[]>([]);
  const [cloudArchives, setCloudArchives] = useState<ReportArchiveItem[]>([]);
  const [baseAuditLogs, setBaseAuditLogs] = useState<ReportAuditLogItem[]>([]);
  const [cloudAuditLogs, setCloudAuditLogs] = useState<ReportAuditLogItem[]>([]);
  const [search, setSearch] = useState('');
  const [financialYear, setFinancialYear] = useState('ALL');
  const [actionFilter, setActionFilter] = useState('ALL');
  const [loading, setLoading] = useState(false);

  const canViewAudit =
    currentUser.role === 'ADMIN' || Boolean(currentUser.permissions?.['report.audit.view']);
  const canDelete =
    currentUser.role === 'ADMIN' ||
    currentUser.role === 'MANAGER' ||
    Boolean(currentUser.permissions?.['report.delete']);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const arcRes = await reportApi.listArchives({
        search: search || undefined,
        financialYear: financialYear !== 'ALL' ? financialYear : undefined,
      });
      setBaseArchives(arcRes.data);

      if (canViewAudit) {
        const audRes = await reportApi.listAuditLogs({
          search: search || undefined,
          action: actionFilter !== 'ALL' ? actionFilter : undefined,
        });
        setBaseAuditLogs(audRes.data);
      }
    } catch (err) {
      onShowToast('error', 'Failed to load archive/audit data', extractFriendlyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [search, financialYear, actionFilter, canViewAudit, onShowToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!cloudSync.userUid) return;
    let lastErrorAt = 0;
    const notifyError = (label: string, err: unknown) => {
      const now = Date.now();
      if (now - lastErrorAt > 8000) {
        lastErrorAt = now;
        onShowToast('error', `${label} Sync Error`, extractFriendlyErrorMessage(err));
      }
    };
    const unsubArchives = subscribeReportArchivesFromFirestore(
      (items) => setCloudArchives(items),
      (err) => notifyError('Report Archives', err)
    );
    const canListAudit =
      canViewAudit &&
      (currentUser.role === 'ADMIN' ||
        currentUser.role === 'MANAGER' ||
        currentUser.role === 'AUDITOR');
    const unsubAudit = canListAudit
      ? subscribeReportAuditLogsFromFirestore(
          (logs) => setCloudAuditLogs(logs),
          (err) => notifyError('Report Audit Logs', err)
        )
      : () => {};
    return () => {
      unsubArchives();
      unsubAudit();
    };
  }, [cloudSync.userUid, canViewAudit, currentUser.role, onShowToast]);

  const archives = useMemo(() => {
    const map = new Map<string, ReportArchiveItem>();
    for (const a of baseArchives) map.set(a.archiveCode, a);
    for (const a of cloudArchives) {
      if (a.archiveCode) map.set(a.archiveCode, a);
    }
    const q = search.trim().toLowerCase();
    return Array.from(map.values())
      .filter((a) => {
        if (a.deletionStatus === 'DELETED') return false;
        if (currentUser.role === 'STAFF' && a.generatedBy !== currentUser.userId) return false;
        if (financialYear !== 'ALL' && a.financialYear !== financialYear) return false;
        if (
          q &&
          !a.archiveCode.toLowerCase().includes(q) &&
          !a.reportTitle.toLowerCase().includes(q) &&
          !a.reportKey.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }, [baseArchives, cloudArchives, search, financialYear, currentUser.role, currentUser.userId]);

  const auditLogs = useMemo(() => {
    const seen = new Set<string>();
    const combined: ReportAuditLogItem[] = [];
    for (const item of [...baseAuditLogs, ...cloudAuditLogs]) {
      const key = `${item.id}_${item.action}_${item.reportName}_${item.createdAt}`;
      if (!seen.has(key)) {
        seen.add(key);
        combined.push(item);
      }
    }
    const q = search.trim().toLowerCase();
    return combined
      .filter((l) => {
        if (actionFilter !== 'ALL' && l.action !== actionFilter) return false;
        if (
          q &&
          !l.reportName.toLowerCase().includes(q) &&
          !l.actorUserId.toLowerCase().includes(q) &&
          !l.action.toLowerCase().includes(q)
        ) {
          return false;
        }
        return true;
      })
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }, [baseAuditLogs, cloudAuditLogs, search, actionFilter]);

  const handleDownload = async (arc: ReportArchiveItem) => {
    try {
      const ext = arc.exportFormat === 'PDF' ? 'pdf' : arc.exportFormat === 'CSV' ? 'csv' : 'xlsx';
      await reportApi.downloadArchive(arc.archiveCode, `${arc.archiveCode}_v${arc.versionNo}.${ext}`);
      onShowToast('success', 'Verified & Downloaded', `${arc.archiveCode} SHA-256 checksum verified.`);
      loadData();
    } catch (err) {
      onShowToast('error', 'Download Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleReprint = async (arc: ReportArchiveItem) => {
    try {
      const res = await reportApi.reprintArchive(arc.archiveCode);
      if (cloudSync.userUid) {
        await saveReportAuditLogToFirestore(res.data);
      }
      onShowToast('success', 'Reprint Authorized & Audit Logged', `${arc.archiveCode} v${arc.versionNo}`);
      loadData();
    } catch (err) {
      onShowToast('error', 'Reprint Blocked', extractFriendlyErrorMessage(err));
    }
  };

  const handleRequestDeletion = async (arc: ReportArchiveItem) => {
    try {
      const res = await reportApi.requestArchiveDeletion(arc.archiveCode, 'Superseded report version cleanup');
      if (cloudSync.userUid) {
        await saveReportArchiveToFirestore(res.data);
      }
      onShowToast('info', 'Deletion Requested', 'Awaiting Admin approval.');
      loadData();
    } catch (err) {
      onShowToast('error', 'Request Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleAdminReview = async (arc: ReportArchiveItem, decision: 'APPROVE' | 'REJECT') => {
    try {
      const res = await reportApi.reviewArchiveDeletion(arc.archiveCode, decision);
      if (cloudSync.userUid) {
        await saveReportArchiveToFirestore(res.data);
      }
      onShowToast('success', `Archive Deletion ${decision === 'APPROVE' ? 'Approved' : 'Rejected'}`);
      loadData();
    } catch (err) {
      onShowToast('error', 'Review Failed', extractFriendlyErrorMessage(err));
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-neutral-950 dark:text-white tracking-tight">
            Encrypted Report Archive, Versioning &amp; Immutable Audit Logs
          </h1>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            Private AES-256-GCM encrypted report snapshots with SHA-256 integrity verification, 8-year statutory retention, and Admin-approved deletion governance.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('archives')}
            className={`px-3.5 py-2 rounded text-xs font-medium cursor-pointer ${
              tab === 'archives'
                ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                : 'bg-neutral-100 dark:bg-neutral-900'
            }`}
          >
            Encrypted Archives ({archives.length})
          </button>
          {canViewAudit && (
            <button
              type="button"
              onClick={() => setTab('audit')}
              className={`px-3.5 py-2 rounded text-xs font-medium cursor-pointer ${
                tab === 'audit'
                  ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                  : 'bg-neutral-100 dark:bg-neutral-900'
              }`}
            >
              Report Audit Trail ({auditLogs.length})
            </button>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3.5 flex flex-wrap items-center gap-3 text-xs">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="h-3.5 w-3.5 text-neutral-400 absolute left-2.5 top-2.5" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search archive code, report title, actor user ID..."
            className="w-full h-8 pl-8 pr-3 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
          />
        </div>
        {tab === 'archives' ? (
          <select
            value={financialYear}
            onChange={(e) => setFinancialYear(e.target.value)}
            className="h-8 px-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
          >
            <option value="ALL">All FYs</option>
            <option value="2026-27">FY 2026-27</option>
            <option value="2025-26">FY 2025-26</option>
          </select>
        ) : (
          <select
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="h-8 px-2.5 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded"
          >
            <option value="ALL">All Actions</option>
            <option value="EXPORT_PDF">EXPORT_PDF</option>
            <option value="EXPORT_COMBINED_PDF">EXPORT_COMBINED_PDF</option>
            <option value="EXPORT_EXCEL">EXPORT_EXCEL</option>
            <option value="PRINT_REPORT">PRINT_REPORT</option>
            <option value="UNAUTHORIZED_ACCESS">UNAUTHORIZED_ACCESS</option>
          </select>
        )}
        <Button variant="outline" size="sm" loading={loading} onClick={loadData}>
          Refresh
        </Button>
      </div>

      {tab === 'archives' ? (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800">
              <tr>
                <th className="px-4 py-2.5">Archive Code &amp; Title</th>
                <th className="px-4 py-2.5">Format / Ver</th>
                <th className="px-4 py-2.5">Retention Until</th>
                <th className="px-4 py-2.5">Generated By</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {archives.map((arc) => (
                <tr key={arc.archiveCode}>
                  <td className="px-4 py-2.5">
                    <div className="font-semibold text-neutral-950 dark:text-white">{arc.reportTitle}</div>
                    <div className="font-mono text-[11px] text-neutral-500">
                      {arc.archiveCode} · SHA-256: {arc.checksumSha256.slice(0, 14)}… ({arc.rowCount} rows)
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono">
                    {arc.exportFormat} · v{arc.versionNo}
                    {arc.passwordProtected ? ' · LOCKED' : ''}
                  </td>
                  <td className="px-4 py-2.5 font-mono">{arc.retentionUntil}</td>
                  <td className="px-4 py-2.5 font-mono">{arc.generatedBy}</td>
                  <td className="px-4 py-2.5 font-mono">
                    {arc.deletionStatus === 'PENDING_ADMIN_APPROVAL' ? (
                      <span className="text-amber-700 dark:text-amber-400">PENDING DELETE</span>
                    ) : (
                      <span className="text-emerald-700 dark:text-emerald-400">ACTIVE</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right space-x-1.5 whitespace-nowrap">
                    <Button variant="outline" size="sm" onClick={() => handleDownload(arc)} icon={<Download className="h-3 w-3" />}>
                      Download
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => handleReprint(arc)} icon={<Printer className="h-3 w-3" />}>
                      Reprint
                    </Button>
                    {arc.deletionStatus === 'ACTIVE' && canDelete && (
                      <Button variant="outline" size="sm" onClick={() => handleRequestDeletion(arc)} icon={<Trash2 className="h-3 w-3 text-red-600" />}>
                        Req Delete
                      </Button>
                    )}
                    {arc.deletionStatus === 'PENDING_ADMIN_APPROVAL' && currentUser.role === 'ADMIN' && (
                      <>
                        <Button variant="primary" size="sm" onClick={() => handleAdminReview(arc, 'APPROVE')} icon={<Check className="h-3 w-3" />}>
                          Approve
                        </Button>
                        <Button variant="outline" size="sm" onClick={() => handleAdminReview(arc, 'REJECT')} icon={<X className="h-3 w-3" />}>
                          Reject
                        </Button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {archives.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-neutral-500">
                    No archived reports yet. Export any report in PDF or Excel to create versioned encrypted archives.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead className="bg-neutral-50 dark:bg-neutral-950 border-b border-neutral-200 dark:border-neutral-800">
              <tr>
                <th className="px-4 py-2.5">Timestamp</th>
                <th className="px-4 py-2.5">Actor / Role</th>
                <th className="px-4 py-2.5">Action</th>
                <th className="px-4 py-2.5">Report / Format</th>
                <th className="px-4 py-2.5">Status / IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {auditLogs.map((log) => (
                <tr key={log.id}>
                  <td className="px-4 py-2.5 font-mono text-[11px] whitespace-nowrap">
                    {log.createdAt.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="px-4 py-2.5 font-mono">
                    {log.actorUserId} ({log.actorRole})
                  </td>
                  <td className="px-4 py-2.5 font-mono font-semibold">{log.action}</td>
                  <td className="px-4 py-2.5">
                    <div>{log.reportName}</div>
                    <div className="text-[11px] text-neutral-500">
                      {log.reportCategory} · {log.exportFormat} · {log.dateRangeLabel}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono">
                    <span
                      className={`inline-flex items-center gap-1 ${
                        log.status === 'SUCCESS' ? 'text-emerald-700' : 'text-red-600'
                      }`}
                    >
                      <ShieldCheck className="h-3.5 w-3.5" /> {log.status}
                    </span>
                    <div className="text-[10px] text-neutral-400">{log.ipAddress}</div>
                  </td>
                </tr>
              ))}
              {auditLogs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-neutral-500">
                    No report audit entries recorded matching filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
