import React, { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  CheckCircle2,
  CreditCard,
  Download,
  FileCheck2,
  Printer,
  Send,
  Trash2,
  Truck,
  Upload,
  UserCheck,
  XCircle,
} from 'lucide-react';
import {
  ErpApplicationItem,
  ErpApplicationStatus,
  ErpPaymentItem,
  ErpRefundItem,
  ReferenceFieldDefItem,
  UserProfile,
} from '../../modules/types';
import { erpApi, readFileAsBase64 } from '../../services/erpApi';
import {
  deleteApplicationFromFirestore,
  getApplicationFromFirestore,
  saveApplicationToFirestore,
  savePaymentToFirestore,
  saveRefundToFirestore,
} from '../../services/erpFirestore';
import { saveDeliveryRecordToFirestore } from '../../services/erpLedgerFirestore';
import {
  downloadCloudAttachment,
  uploadAttachmentToFirebaseStorage,
} from '../../services/storageService';
import { extractFriendlyErrorMessage } from '../../services/firebase';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { formatCurrency } from '../../services/apiClient';
import { formatDateIST } from '../../services/formatters';

interface ApplicationProfileViewProps {
  applicationNo: string;
  currentUser: UserProfile;
  onClose: () => void;
  onUpdated: () => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

const ALLOWED_TRANSITIONS: Record<ErpApplicationStatus, ErpApplicationStatus[]> = {
  Draft: ['Submitted', 'Cancelled'],
  Submitted: ['Under Review', 'Processing', 'Pending Customer', 'On Hold', 'Cancelled', 'Rejected'],
  'Under Review': ['Processing', 'Pending Customer', 'Pending Office', 'Approved', 'Rejected', 'On Hold', 'Cancelled'],
  Processing: ['Pending Customer', 'Pending Office', 'Approved', 'Completed', 'Rejected', 'On Hold', 'Cancelled'],
  'Pending Customer': ['Under Review', 'Processing', 'On Hold', 'Cancelled', 'Rejected'],
  'Pending Office': ['Under Review', 'Processing', 'Approved', 'Rejected', 'Completed', 'On Hold', 'Cancelled'],
  Approved: ['Processing', 'Completed', 'Cancelled', 'On Hold'],
  Rejected: ['Reopened'],
  Completed: ['Reopened'],
  Cancelled: ['Reopened'],
  'On Hold': ['Under Review', 'Processing', 'Pending Customer', 'Pending Office', 'Cancelled', 'Rejected'],
  Reopened: ['Under Review', 'Processing', 'Pending Customer', 'Pending Office', 'Approved', 'Completed', 'Cancelled'],
};

export const ApplicationProfileView: React.FC<ApplicationProfileViewProps> = ({
  applicationNo,
  currentUser,
  onClose,
  onUpdated,
  onShowToast,
}) => {
  const [app, setApp] = useState<ErpApplicationItem | null>(null);
  const [refFields, setRefFields] = useState<ReferenceFieldDefItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'overview' | 'docs' | 'refs' | 'notes' | 'finance' | 'delivery' | 'print'>('overview');

  // Action states
  const [nextStatus, setNextStatus] = useState<string>('');
  const [statusReason, setStatusReason] = useState('');
  const [assignStaffId, setAssignStaffId] = useState('');
  const [assignCounterCode, setAssignCounterCode] = useState('CTR-01');
  const [reassignReason, setReassignReason] = useState('');

  // Reference entry
  const [refKey, setRefKey] = useState('');
  const [refVal, setRefVal] = useState('');
  const [refReason, setRefReason] = useState('');

  // Notes & Followups
  const [noteType, setNoteType] = useState<'INTERNAL' | 'CUSTOMER_REMARK'>('CUSTOMER_REMARK');
  const [noteContent, setNoteContent] = useState('');
  const [fuDate, setFuDate] = useState('');
  const [fuReason, setFuReason] = useState('');

  // Payment & Refund
  const [payAmount, setPayAmount] = useState(0);
  const [payMethod, setPayMethod] = useState<'Cash' | 'UPI' | 'Card'>('Cash');
  const [payUpiRef, setPayUpiRef] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundAmount, setRefundAmount] = useState(0);
  const [refundTxnId, setRefundTxnId] = useState('');

  // Delivery & Cancellation
  const [deliverableType, setDeliverableType] = useState('Original Document / Printout');
  const [deliveryMethod, setDeliveryMethod] = useState('Physical Handover');
  const [receivedBy, setReceivedBy] = useState('');
  const [handoverConfirmed, setHandoverConfirmed] = useState(true);
  const [cancelReason, setCancelReason] = useState('');

  // Notification test
  const [notifChannel, setNotifChannel] = useState<'DASHBOARD' | 'SMS' | 'WHATSAPP' | 'EMAIL_SMTP'>('SMS');
  const [confirmPermanentDelete, setConfirmPermanentDelete] = useState(false);
  const [deletingApp, setDeletingApp] = useState(false);
  const [archivingApp, setArchivingApp] = useState(false);

  const loadDetail = useCallback(async (): Promise<ErpApplicationItem | null> => {
    setLoading(true);
    try {
      let loadedApp: ErpApplicationItem | null = null;
      let loadedRefs: ReferenceFieldDefItem[] = [];
      try {
        const [detRes, refRes] = await Promise.all([
          erpApi.getApplicationDetail(applicationNo),
          erpApi.listReferenceFields(),
        ]);
        loadedApp = detRes.data.application;
        loadedRefs = refRes.data;
      } catch (apiErr) {
        const cloudApp = await getApplicationFromFirestore(applicationNo);
        if (!cloudApp) {
          throw apiErr;
        }
        loadedApp = cloudApp;
        try {
          const refRes = await erpApi.listReferenceFields();
          loadedRefs = refRes.data;
        } catch {
          loadedRefs = [];
        }
      }
      setApp(loadedApp);
      setRefFields(loadedRefs);
      const nextOpts = ALLOWED_TRANSITIONS[loadedApp.status] ?? [];
      setNextStatus(nextOpts[0] ?? '');
      setPayAmount(loadedApp.financialSummary?.balanceDue || 0);
      setReceivedBy(loadedApp.customerSnapshot?.fullName || '');
      if (loadedApp.payments.length > 0) {
        setRefundTxnId(loadedApp.payments[0].transactionId);
        setRefundAmount(loadedApp.payments[0].amount);
      }
      if (loadedRefs.length > 0 && !refKey) {
        setRefKey(loadedRefs[0].fieldKey);
      }
      return loadedApp;
    } catch (err) {
      onShowToast('error', 'Failed to inspect Application', extractFriendlyErrorMessage(err));
      return null;
    } finally {
      setLoading(false);
    }
  }, [applicationNo, onShowToast, refKey]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  const syncMutatedApp = useCallback(
    async (fallbackUpdater?: (prev: ErpApplicationItem) => ErpApplicationItem): Promise<ErpApplicationItem> => {
      try {
        const detRes = await erpApi.getApplicationDetail(applicationNo);
        const saved = await saveApplicationToFirestore(detRes.data.application);
        setApp(saved);
        return saved;
      } catch (err) {
        if (app && fallbackUpdater) {
          const updated = fallbackUpdater(app);
          const saved = await saveApplicationToFirestore(updated);
          setApp(saved);
          return saved;
        }
        throw err;
      }
    },
    [app, applicationNo]
  );

  const handleStatusTransition = async () => {
    if (!app || !nextStatus) return;
    try {
      let updatedFromExpress: ErpApplicationItem | null = null;
      try {
        const res = await erpApi.transitionStatus(app.applicationNo, {
          nextStatus,
          reason: statusReason,
        });
        updatedFromExpress = res.data;
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        if (!(msg.includes('not found') || msg.includes('404'))) throw err;
        const nowIso = new Date().toISOString();
        const nextSt = nextStatus as ErpApplicationStatus;
        updatedFromExpress = {
          ...app,
          status: nextSt,
          actualCompletionDate: nextSt === 'Completed' ? nowIso : app.actualCompletionDate,
          statusHistory: [
            {
              id: Date.now(),
              previousStatus: app.status,
              newStatus: nextSt,
              changedBy: currentUser.userId,
              changedByRole: currentUser.role,
              remarks: statusReason || 'Status updated',
              reason: statusReason || 'Status updated',
              changedAt: nowIso,
            },
            ...app.statusHistory,
          ],
          updatedAt: nowIso,
        };
      }
      const saved = await saveApplicationToFirestore(updatedFromExpress);
      setApp(saved);
      setStatusReason('');
      onShowToast('success', 'Workflow Saved to Cloud', `${app.applicationNo} -> ${nextStatus}`);
      onUpdated();
    } catch (err) {
      onShowToast('error', 'Transition Rejected', extractFriendlyErrorMessage(err));
    }
  };

  const handleAssignOrReassign = async () => {
    if (!app) return;
    try {
      const nowIso = new Date().toISOString();
      if (currentUser.role === 'STAFF') {
        try {
          await erpApi.requestReassignment(app.applicationNo, {
            proposedStaffId: assignStaffId || null,
            proposedCounterCode: assignCounterCode,
            reason: reassignReason,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message.toLowerCase() : '';
          if (!(msg.includes('not found') || msg.includes('404'))) throw err;
        }
        await syncMutatedApp((prev) => ({
          ...prev,
          reassignments: [
            {
              requestCode: `REASGN_${Date.now()}`,
              applicationNo: prev.applicationNo,
              requestedBy: currentUser.userId,
              currentStaffId: prev.assignedStaffId,
              proposedStaffId: assignStaffId || null,
              proposedCounterCode: assignCounterCode,
              reason: reassignReason,
              status: 'Pending',
              reviewedBy: null,
              createdAt: nowIso,
            },
            ...prev.reassignments,
          ],
          updatedAt: nowIso,
        }));
        onShowToast('success', 'Reassignment Request Saved', 'Pending Manager/Admin approval.');
      } else {
        try {
          await erpApi.assignApplication(app.applicationNo, {
            assignedStaffId: assignStaffId || null,
            assignedCounterCode: assignCounterCode,
            reason: reassignReason || 'Supervisor assignment',
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message.toLowerCase() : '';
          if (!(msg.includes('not found') || msg.includes('404'))) throw err;
        }
        await syncMutatedApp((prev) => ({
          ...prev,
          assignedStaffId: assignStaffId || null,
          assignedCounterCode: assignCounterCode,
          assignmentHistory: [
            {
              id: Date.now(),
              previousStaffId: prev.assignedStaffId,
              newStaffId: assignStaffId || null,
              previousCounterCode: prev.assignedCounterCode,
              newCounterCode: assignCounterCode,
              assignedBy: currentUser.userId,
              reason: reassignReason || 'Supervisor assignment',
              assignedAt: nowIso,
            },
            ...prev.assignmentHistory,
          ],
          updatedAt: nowIso,
        }));
        onShowToast('success', 'Application Assignment Saved');
      }
      setReassignReason('');
      onUpdated();
    } catch (err) {
      onShowToast('error', 'Assignment Failed', extractFriendlyErrorMessage(err));
    }
  };

  const handleDownloadPrivateDoc = async (docItem: ErpApplicationItem['documents'][0]) => {
    try {
      const downloadedFromCloud = await downloadCloudAttachment({
        storageUrl: docItem.storageUrl,
        storagePath: docItem.storagePath,
        fileName: docItem.originalName,
        fallbackMimeType: docItem.mimeType,
      });
      if (downloadedFromCloud) {
        onShowToast('info', 'Cloud Attachment Downloaded', docItem.originalName);
        return;
      }
      const res = await erpApi.downloadDocument(docItem.fileUuid);
      const bytes = Uint8Array.from(atob(res.data.contentBase64), (c) => c.charCodeAt(0));
      const blob = new Blob([bytes], { type: res.data.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = res.data.originalName;
      a.click();
      URL.revokeObjectURL(url);
      onShowToast('info', 'Private Download Logged', res.data.originalName);
    } catch (err) {
      onShowToast('error', 'Download Blocked', extractFriendlyErrorMessage(err));
    }
  };

  const handleUploadDoc = async (docKey: string, category: string, file: File | null, replaceUuid?: string) => {
    if (!app || !file) return;
    try {
      const cloudFile = await uploadAttachmentToFirebaseStorage({
        file,
        folder: `applications/${app.customerId}/${app.applicationNo}`,
        fileName: file.name,
        contentType: file.type,
      });
      const contentBase64 = await readFileAsBase64(file);
      let uploadedDoc: ErpApplicationItem['documents'][0] | null = null;
      try {
        const upRes = await erpApi.uploadDocument(app.applicationNo, {
          docKey,
          category,
          originalName: file.name,
          mimeType: file.type,
          contentBase64,
          fileSizeBytes: cloudFile.fileSizeBytes,
          storageUrl: cloudFile.downloadUrl,
          storagePath: cloudFile.storagePath,
          replaceFileUuid: replaceUuid,
        });
        const cleanedDoc = {
          ...upRes.data.document,
          storageUrl: cloudFile.downloadUrl,
          storagePath: cloudFile.storagePath,
        };
        delete (cleanedDoc as unknown as Record<string, unknown>).contentBase64;
        uploadedDoc = cleanedDoc;
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : '';
        if (!(msg.includes('not found') || msg.includes('404'))) throw err;
        uploadedDoc = {
          id: Date.now(),
          fileUuid: `DOC_${Date.now()}`,
          applicationNo: app.applicationNo,
          customerId: app.customerId,
          docKey,
          category,
          originalName: file.name,
          mimeType: (file.type as 'application/pdf' | 'image/jpeg' | 'image/png') || 'application/pdf',
          fileSizeBytes: cloudFile.fileSizeBytes || file.size,
          storageUrl: cloudFile.downloadUrl,
          storagePath: cloudFile.storagePath,
          verificationStatus: 'Pending',
          versionNo: 1,
          replacedFileUuid: replaceUuid ?? null,
          uploadedBy: currentUser.userId,
          uploadedAt: new Date().toISOString(),
        };
      }
      await syncMutatedApp((prev) => ({
        ...prev,
        documents: uploadedDoc ? [uploadedDoc, ...prev.documents] : prev.documents,
        checklistSummary: {
          ...prev.checklistSummary,
          uploadedDocuments: prev.documents.length + 1,
          pendingVerification: prev.checklistSummary.pendingVerification + 1,
        },
        updatedAt: new Date().toISOString(),
      }));
      onShowToast('success', 'Document Uploaded & Saved to Cloud', file.name);
      onUpdated();
    } catch (err) {
      onShowToast('error', 'Upload Rejected', extractFriendlyErrorMessage(err));
    }
  };

  if (!app && loading) {
    return (
      <Modal isOpen={true} onClose={onClose} title={`Loading ${applicationNo}...`}>
        <div className="p-6 text-xs text-neutral-500">Fetching full 25-point application profile...</div>
      </Modal>
    );
  }
  if (!app) return null;

  const canApproveDocs = currentUser.role === 'ADMIN' || currentUser.role === 'MANAGER';
  const nextStatuses = ALLOWED_TRANSITIONS[app.status] ?? [];
  const applicableRefDefs = refFields.filter(
    (r) => r.enabled && (r.serviceId === 'ALL' || r.serviceId === app.serviceId)
  );

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={`${app.applicationNo} · ${app.serviceSnapshot.name}`}
      description={`${app.customerSnapshot.fullName} (${app.customerId}) · SLA: ${app.slaStatus.label} · Due ${formatDateIST(app.expectedCompletionDate)}`}
      maxWidthClass="max-w-6xl"
    >
      <div className="space-y-4">
        {/* Top Workflow & Quick Stats Strip */}
        <div className="bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <span className="text-neutral-500">Status: </span>
              <span className="font-bold text-neutral-950 dark:text-white">{app.status}</span>
            </div>
            <div>
              <span className="text-neutral-500">Assigned: </span>
              <span className="font-mono font-semibold">{app.assignedStaffId || 'Unassigned'}</span> ({app.assignedCounterCode || '-'})
            </div>
            <div>
              <span className="text-neutral-500">Checklist: </span>
              <span className="font-mono font-semibold">
                {app.checklistSummary.verifiedDocuments} verified / {app.checklistSummary.uploadedDocuments} uploaded / {app.checklistSummary.missingCount} missing
              </span>
            </div>
            <div>
              <span className="text-neutral-500">Payment: </span>
              <span className="font-mono font-semibold">
                {app.financialSummary.paymentStatus} ({formatCurrency(app.financialSummary.netCollected)} / {formatCurrency(app.financialSummary.serviceCharge)})
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!app.assignedStaffId && (
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  try {
                    try {
                      await erpApi.assignApplication(app.applicationNo, { action: 'CLAIM' });
                    } catch (err) {
                      const msg = err instanceof Error ? err.message.toLowerCase() : '';
                      if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                    }
                    await syncMutatedApp((prev) => ({
                      ...prev,
                      assignedStaffId: currentUser.userId,
                      assignedCounterCode: 'CTR-01',
                      updatedAt: new Date().toISOString(),
                    }));
                    onShowToast('success', 'Application Claimed & Saved');
                    onUpdated();
                  } catch (err) {
                    onShowToast('error', 'Claim Failed', extractFriendlyErrorMessage(err));
                  }
                }}
                icon={<UserCheck className="h-3.5 w-3.5" />}
              >
                Claim Unassigned
              </Button>
            )}

            {currentUser.role === 'ADMIN' && !app.archivedAt && (
              <Button
                size="sm"
                variant="outline"
                loading={archivingApp}
                onClick={async () => {
                  setArchivingApp(true);
                  try {
                    try {
                      await erpApi.archiveApplication(app.applicationNo, 'Archived by Admin');
                    } catch (err) {
                      const msg = err instanceof Error ? err.message.toLowerCase() : '';
                      if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                    }
                    await syncMutatedApp((prev) => ({
                      ...prev,
                      archivedAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    }));
                    onShowToast('info', 'Application Archived', app.applicationNo);
                    window.dispatchEvent(new CustomEvent('mun:applications-changed'));
                    onUpdated();
                    onClose();
                  } catch (err) {
                    onShowToast('error', 'Archive Failed', extractFriendlyErrorMessage(err));
                  } finally {
                    setArchivingApp(false);
                  }
                }}
                icon={<Archive className="h-3.5 w-3.5" />}
              >
                Archive
              </Button>
            )}

            {currentUser.role === 'ADMIN' &&
              (!confirmPermanentDelete ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setConfirmPermanentDelete(true)}
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                >
                  Delete Permanently
                </Button>
              ) : (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="danger"
                    loading={deletingApp}
                    onClick={async () => {
                      setDeletingApp(true);
                      try {
                        try {
                          await erpApi.deleteApplication(app.applicationNo);
                        } catch (err) {
                          const msg = err instanceof Error ? err.message.toLowerCase() : '';
                          if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                        }
                        await deleteApplicationFromFirestore(app.applicationNo);
                        onShowToast('success', 'Application Permanently Deleted', app.applicationNo);
                        window.dispatchEvent(new CustomEvent('mun:applications-changed'));
                        onUpdated();
                        onClose();
                      } catch (err) {
                        onShowToast('error', 'Delete Blocked', extractFriendlyErrorMessage(err));
                        setConfirmPermanentDelete(false);
                      } finally {
                        setDeletingApp(false);
                      }
                    }}
                  >
                    Confirm Delete
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deletingApp}
                    onClick={() => setConfirmPermanentDelete(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ))}
          </div>
        </div>

        {/* Sub-navigation Tabs */}
        <div className="flex flex-wrap gap-1.5 border-b border-neutral-200 dark:border-neutral-800 pb-2 text-xs no-print">
          {(
            [
              ['overview', 'Workflow & Form Data'],
              ['docs', `Documents (${app.documents.length})`],
              ['refs', `References (${app.references.length})`],
              ['notes', `Notes & Follow-ups (${app.notes.length + app.followUps.length})`],
              ['finance', `Payments & Refunds (${app.payments.length})`],
              ['delivery', 'Delivery & Cancel'],
              ['print', 'A4 Customer Print Preview'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded border font-medium cursor-pointer ${
                tab === id
                  ? 'bg-neutral-950 text-white border-neutral-950 dark:bg-white dark:text-neutral-950'
                  : 'border-neutral-200 dark:border-neutral-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 text-xs">
            <div className="lg:col-span-6 space-y-4">
              {/* Status Transition Box */}
              <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                <div className="font-semibold text-sm">Transition Workflow Status</div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select
                    value={nextStatus}
                    onChange={(e) => setNextStatus(e.target.value)}
                    className="h-9 px-2 border rounded bg-white dark:bg-neutral-950"
                  >
                    {nextStatuses.map((st) => (
                      <option key={st} value={st}>{st}</option>
                    ))}
                  </select>
                  <input
                    value={statusReason}
                    onChange={(e) => setStatusReason(e.target.value)}
                    placeholder="Reason / Remarks (Mandatory for Hold/Reject/Cancel/Reopen)"
                    className="h-9 px-2.5 border rounded bg-white dark:bg-neutral-950"
                  />
                </div>
                <Button size="sm" variant="primary" onClick={handleStatusTransition} disabled={!nextStatus}>
                  Apply Status Transition
                </Button>
              </div>

              {/* Assignment / Reassignment Box */}
              <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                <div className="font-semibold text-sm">
                  {currentUser.role === 'STAFF' ? 'Request Reassignment (Needs Approval)' : 'Assign / Transfer Staff & Counter'}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={assignStaffId}
                    onChange={(e) => setAssignStaffId(e.target.value)}
                    placeholder="Staff User ID (MCYYFFMMSSSS)"
                    className="h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-950"
                  />
                  <input
                    value={assignCounterCode}
                    onChange={(e) => setAssignCounterCode(e.target.value)}
                    placeholder="Counter (e.g. CTR-01)"
                    className="h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-950"
                  />
                </div>
                <input
                  value={reassignReason}
                  onChange={(e) => setReassignReason(e.target.value)}
                  placeholder="Assignment / transfer reason..."
                  className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-950"
                />
                <Button size="sm" variant="outline" onClick={handleAssignOrReassign}>
                  {currentUser.role === 'STAFF' ? 'Submit Reassignment Request' : 'Update Assignment'}
                </Button>
              </div>

              {/* Submitted Form Values (Snapshot Versioned) */}
              <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                <div className="font-semibold text-sm">
                  Submitted Form Data (Form v{app.serviceSnapshot.appliedFormVersion} Snapshot)
                </div>
                <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {app.serviceSnapshot.formFieldsSnapshot.map((f) => (
                    <div key={f.fieldKey} className="py-1.5 flex justify-between gap-4">
                      <dt className="text-neutral-500">{f.label}</dt>
                      <dd className="font-medium text-right">
                        {Array.isArray(app.formData[f.fieldKey])
                          ? (app.formData[f.fieldKey] as string[]).join(', ')
                          : String(app.formData[f.fieldKey] ?? '-')}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>

            {/* Right: Timeline & Consent-Gated Notification Dispatch */}
            <div className="lg:col-span-6 space-y-4">
              <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                <div className="font-semibold text-sm">Consent-Gated Notification Dispatch</div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={notifChannel}
                    onChange={(e) => setNotifChannel(e.target.value as typeof notifChannel)}
                    className="h-8 px-2 border rounded bg-white dark:bg-neutral-950"
                  >
                    <option value="DASHBOARD">Internal Dashboard Alert</option>
                    <option value="SMS">SMS Gateway (Consent + Config Gated)</option>
                    <option value="WHATSAPP">WhatsApp (Consent + Config Gated)</option>
                    <option value="EMAIL_SMTP">Email SMTP (Consent + Config Gated)</option>
                  </select>
                  <Button
                    size="sm"
                    variant="outline"
                    icon={<Send className="h-3 w-3" />}
                    onClick={async () => {
                      try {
                        const res = await erpApi.sendNotification({
                          customerId: app.customerId,
                          applicationNo: app.applicationNo,
                          channel: notifChannel,
                          eventKey: 'APPLICATION_STATUS_UPDATE',
                          consentCategory:
                            notifChannel === 'SMS'
                              ? 'SMS_CONSENT'
                              : notifChannel === 'WHATSAPP'
                                ? 'WHATSAPP_CONSENT'
                                : 'STATUS_UPDATE_CONSENT',
                          messagePreview: `Status update for ${app.applicationNo}: currently ${app.status}.`,
                        });
                        await syncMutatedApp((prev) => ({
                          ...prev,
                          notifications: [res.data, ...prev.notifications],
                          updatedAt: new Date().toISOString(),
                        }));
                        onShowToast('info', `Channel Status: ${res.data.status}`, res.data.statusReason);
                      } catch (err) {
                        onShowToast('error', 'Notification Failed', extractFriendlyErrorMessage(err));
                      }
                    }}
                  >
                    Send Status Alert
                  </Button>
                </div>
                <div className="max-h-32 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800">
                  {app.notifications.map((n) => (
                    <div key={n.id} className="py-1.5 flex justify-between gap-2">
                      <span>[{n.channel}] {n.messagePreview}</span>
                      <span className="font-mono font-semibold shrink-0">{n.status}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
                <div className="font-semibold text-sm">Status &amp; Activity Audit Trail</div>
                <div className="max-h-60 overflow-y-auto divide-y divide-neutral-100 dark:divide-neutral-800">
                  {app.statusHistory.map((h) => (
                    <div key={h.id} className="py-1.5">
                      <div className="font-semibold">
                        {h.previousStatus || 'INIT'} → {h.newStatus}
                      </div>
                      <div className="text-neutral-500">
                        By {h.changedBy} ({h.changedByRole}) · {h.reason}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {tab === 'docs' && (
          <div className="space-y-4 text-xs">
            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2">
              <div className="font-semibold text-sm">Service Document Checklist &amp; Private Vault Upload</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {app.serviceSnapshot.requiredDocsSnapshot.map((rd) => (
                  <div key={rd.docKey} className="border border-neutral-200 dark:border-neutral-800 rounded p-3 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold">{rd.label} {rd.required ? '*' : '(Optional)'}</div>
                      <div className="text-[11px] text-neutral-500">{rd.category} · Max {rd.maxSizeMb} MB</div>
                    </div>
                    <label className="px-2.5 py-1.5 border rounded cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800 inline-flex items-center gap-1">
                      <Upload className="h-3.5 w-3.5" />
                      <span>Upload</span>
                      <input
                        type="file"
                        accept=".pdf,.jpg,.jpeg,.png"
                        className="hidden"
                        onChange={(e) => handleUploadDoc(rd.docKey, rd.category, e.target.files?.[0] ?? null)}
                      />
                    </label>
                  </div>
                ))}
              </div>
            </div>

            <div className="border border-neutral-200 dark:border-neutral-800 rounded divide-y divide-neutral-100 dark:divide-neutral-800">
              {app.documents.length === 0 ? (
                <div className="p-4 text-neutral-500">No documents uploaded yet.</div>
              ) : (
                app.documents.map((doc) => (
                  <div key={doc.fileUuid} className="p-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold flex items-center gap-2">
                        <FileCheck2 className="h-4 w-4" />
                        <span>{doc.originalName}</span>
                        <span className="font-mono text-[11px] text-neutral-500">v{doc.versionNo} · {(doc.fileSizeBytes / 1024).toFixed(1)} KB</span>
                      </div>
                      <div className="text-[11px] text-neutral-500">
                        Status: <span className="font-semibold">{doc.verificationStatus}</span>
                        {doc.rejectionReason ? ` · Rejection: ${doc.rejectionReason}` : ''}
                        {' · Uploaded by '}{doc.uploadedBy}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        icon={<Download className="h-3 w-3" />}
                        onClick={() => handleDownloadPrivateDoc(doc)}
                      >
                        Private Download
                      </Button>
                      <label className="px-2.5 h-8 inline-flex items-center border rounded cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800">
                        Replace
                        <input
                          type="file"
                          accept=".pdf,.jpg,.jpeg,.png"
                          className="hidden"
                          onChange={(e) =>
                            handleUploadDoc(doc.docKey, doc.category, e.target.files?.[0] ?? null, doc.fileUuid)
                          }
                        />
                      </label>
                      {canApproveDocs && doc.verificationStatus !== 'Verified' && (
                        <>
                          <Button
                            size="sm"
                            variant="primary"
                            icon={<CheckCircle2 className="h-3 w-3" />}
                            onClick={async () => {
                              try {
                                try {
                                  await erpApi.verifyDocument(doc.fileUuid, 'Verified', 'Verified clear scan');
                                } catch (err) {
                                  const msg = err instanceof Error ? err.message.toLowerCase() : '';
                                  if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                                }
                                await syncMutatedApp((prev) => ({
                                  ...prev,
                                  documents: prev.documents.map((d) =>
                                    d.fileUuid === doc.fileUuid
                                      ? {
                                          ...d,
                                          verificationStatus: 'Verified',
                                          verifiedBy: currentUser.userId,
                                          verifiedAt: new Date().toISOString(),
                                        }
                                      : d
                                  ),
                                  updatedAt: new Date().toISOString(),
                                }));
                                onShowToast('success', 'Document Verified & Synced');
                                onUpdated();
                              } catch (err) {
                                onShowToast('error', 'Verification Failed', extractFriendlyErrorMessage(err));
                              }
                            }}
                          >
                            Verify
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            icon={<XCircle className="h-3 w-3" />}
                            onClick={async () => {
                              try {
                                try {
                                  await erpApi.verifyDocument(doc.fileUuid, 'Rejected', 'Unclear or incomplete document scan');
                                } catch (err) {
                                  const msg = err instanceof Error ? err.message.toLowerCase() : '';
                                  if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                                }
                                await syncMutatedApp((prev) => ({
                                  ...prev,
                                  documents: prev.documents.map((d) =>
                                    d.fileUuid === doc.fileUuid
                                      ? {
                                          ...d,
                                          verificationStatus: 'Rejected',
                                          rejectionReason: 'Unclear or incomplete document scan',
                                          verifiedBy: currentUser.userId,
                                          verifiedAt: new Date().toISOString(),
                                        }
                                      : d
                                  ),
                                  updatedAt: new Date().toISOString(),
                                }));
                                onShowToast('info', 'Document Rejected & Synced');
                                onUpdated();
                              } catch (err) {
                                onShowToast('error', 'Rejection Failed', extractFriendlyErrorMessage(err));
                              }
                            }}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'refs' && (
          <div className="space-y-4 text-xs">
            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
              <div className="font-semibold text-sm">Add / Update Dynamic Reference Number</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <select
                  value={refKey}
                  onChange={(e) => setRefKey(e.target.value)}
                  className="h-9 px-2 border rounded bg-white dark:bg-neutral-950"
                >
                  {applicableRefDefs.map((rd) => (
                    <option key={rd.fieldKey} value={rd.fieldKey}>
                      {rd.label} ({rd.uniqueScope})
                    </option>
                  ))}
                </select>
                <input
                  value={refVal}
                  onChange={(e) => setRefVal(e.target.value)}
                  placeholder="Reference / Acknowledgement Number"
                  className="h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
                />
                <input
                  value={refReason}
                  onChange={(e) => setRefReason(e.target.value)}
                  placeholder="Update reason (optional)"
                  className="h-9 px-3 border rounded bg-white dark:bg-neutral-950"
                />
              </div>
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  try {
                    let updatedApp: ErpApplicationItem | null = null;
                    try {
                      const res = await erpApi.upsertReference(app.applicationNo, {
                        fieldKey: refKey,
                        value: refVal,
                        reason: refReason,
                      });
                      updatedApp = res.data;
                    } catch (err) {
                      const msg = err instanceof Error ? err.message.toLowerCase() : '';
                      if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                    }
                    const defLabel = refFields.find((r) => r.fieldKey === refKey)?.label || refKey;
                    const nowIso = new Date().toISOString();
                    if (updatedApp) {
                      const saved = await saveApplicationToFirestore(updatedApp);
                      setApp(saved);
                    } else {
                      await syncMutatedApp((prev) => ({
                        ...prev,
                        references: [
                          ...prev.references.filter((r) => r.fieldKey !== refKey),
                          {
                            id: Date.now(),
                            fieldKey: refKey,
                            label: defLabel,
                            value: refVal,
                            addedBy: currentUser.userId,
                            updatedBy: currentUser.userId,
                            updatedAt: nowIso,
                            history: [],
                          },
                        ],
                        updatedAt: nowIso,
                      }));
                    }
                    setRefVal('');
                    setRefReason('');
                    onShowToast('success', 'Reference Number Saved to Cloud');
                    onUpdated();
                  } catch (err) {
                    onShowToast('error', 'Reference Rejected', extractFriendlyErrorMessage(err));
                  }
                }}
              >
                Save Reference Entry
              </Button>
            </div>

            <div className="border border-neutral-200 dark:border-neutral-800 rounded divide-y divide-neutral-100 dark:divide-neutral-800">
              {app.references.length === 0 ? (
                <div className="p-4 text-neutral-500">No external / acknowledgement reference numbers attached yet.</div>
              ) : (
                app.references.map((r) => (
                  <div key={r.fieldKey} className="p-3">
                    <div className="flex justify-between">
                      <span className="font-semibold">{r.label}</span>
                      <span className="font-mono font-bold">{r.value}</span>
                    </div>
                    <div className="text-[11px] text-neutral-500">
                      Updated by {r.updatedBy} · Modification history: {r.history.length} edit(s)
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {tab === 'notes' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Separate Internal Notes vs Customer-Facing Remarks */}
            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
              <div className="font-semibold text-sm">Internal Notes vs Customer Remarks</div>
              <p className="text-[11px] text-neutral-500">
                Internal Staff/Manager notes are strictly hidden from customer receipts and printouts.
              </p>
              <div className="flex gap-2">
                <select
                  value={noteType}
                  onChange={(e) => setNoteType(e.target.value as 'INTERNAL' | 'CUSTOMER_REMARK')}
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-950"
                >
                  <option value="CUSTOMER_REMARK">Customer-Facing Remark</option>
                  <option value="INTERNAL">Internal Staff Note (Private)</option>
                </select>
                <input
                  value={noteContent}
                  onChange={(e) => setNoteContent(e.target.value)}
                  placeholder="Write note..."
                  className="flex-1 h-8 px-2 border rounded bg-white dark:bg-neutral-950"
                />
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    if (!noteContent.trim()) return;
                    try {
                      try {
                        await erpApi.addNote(app.applicationNo, noteType, noteContent);
                      } catch (err) {
                        const msg = err instanceof Error ? err.message.toLowerCase() : '';
                        if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                      }
                      const nowIso = new Date().toISOString();
                      await syncMutatedApp((prev) => ({
                        ...prev,
                        notes: [
                          {
                            id: Date.now(),
                            applicationNo: prev.applicationNo,
                            noteType,
                            content: noteContent.trim(),
                            createdBy: currentUser.userId,
                            createdAt: nowIso,
                          },
                          ...prev.notes,
                        ],
                        updatedAt: nowIso,
                      }));
                      setNoteContent('');
                      onShowToast('success', 'Note Saved to Cloud');
                    } catch (err) {
                      onShowToast('error', 'Note Save Failed', extractFriendlyErrorMessage(err));
                    }
                  }}
                >
                  Add
                </Button>
              </div>
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {app.notes.map((n) => (
                  <div key={n.id} className="py-2">
                    <span className={`font-mono text-[10px] font-bold mr-2 ${n.noteType === 'INTERNAL' ? 'text-amber-700' : 'text-blue-700'}`}>
                      [{n.noteType}]
                    </span>
                    <span>{n.content}</span>
                    <span className="ml-2 text-neutral-400">({n.createdBy})</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Follow-up Scheduler */}
            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
              <div className="font-semibold text-sm">Follow-up Schedule &amp; Reminders</div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="date"
                  value={fuDate}
                  onChange={(e) => setFuDate(e.target.value)}
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-950"
                />
                <input
                  value={fuReason}
                  onChange={(e) => setFuReason(e.target.value)}
                  placeholder="Follow-up action reason"
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-950"
                />
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  if (!fuDate || !fuReason) return;
                  try {
                    try {
                      await erpApi.addFollowUp(app.applicationNo, {
                        followUpDate: fuDate,
                        reason: fuReason,
                      });
                    } catch (err) {
                      const msg = err instanceof Error ? err.message.toLowerCase() : '';
                      if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                    }
                    const nowIso = new Date().toISOString();
                    await syncMutatedApp((prev) => ({
                      ...prev,
                      followUps: [
                        {
                          id: Date.now(),
                          applicationNo: prev.applicationNo,
                          followUpDate: fuDate,
                          followUpTime: '11:00',
                          reason: fuReason,
                          assignedStaffId: prev.assignedStaffId || currentUser.userId,
                          status: 'Pending',
                          remarks: '',
                          createdAt: nowIso,
                        },
                        ...prev.followUps,
                      ],
                      updatedAt: nowIso,
                    }));
                    setFuDate('');
                    setFuReason('');
                    onShowToast('success', 'Follow-up Scheduled & Saved');
                  } catch (err) {
                    onShowToast('error', 'Follow-up Failed', extractFriendlyErrorMessage(err));
                  }
                }}
              >
                Schedule Follow-up
              </Button>
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                {app.followUps.map((f) => (
                  <div key={f.id} className="py-2 flex items-center justify-between gap-2">
                    <div>
                      <div className="font-semibold">{f.reason}</div>
                      <div className="text-neutral-500 font-mono">
                        Due: {f.followUpDate} · {f.status} ({f.assignedStaffId})
                      </div>
                    </div>
                    {f.status === 'Pending' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={async () => {
                          try {
                            try {
                              await erpApi.updateFollowUp(f.id, { status: 'Completed' });
                            } catch (err) {
                              const msg = err instanceof Error ? err.message.toLowerCase() : '';
                              if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                            }
                            await syncMutatedApp((prev) => ({
                              ...prev,
                              followUps: prev.followUps.map((item) =>
                                item.id === f.id ? { ...item, status: 'Completed' } : item
                              ),
                              updatedAt: new Date().toISOString(),
                            }));
                            onShowToast('success', 'Follow-up Completed & Synced');
                          } catch (err) {
                            onShowToast('error', 'Update Failed', extractFriendlyErrorMessage(err));
                          }
                        }}
                      >
                        Done
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'finance' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
              <div className="font-semibold text-sm flex items-center gap-2">
                <CreditCard className="h-4 w-4" />
                Collect Payment (Balance: {formatCurrency(app.financialSummary.balanceDue)})
              </div>
              <div className="grid grid-cols-2 gap-2">
                <input
                  type="number"
                  value={payAmount}
                  onChange={(e) => setPayAmount(Number(e.target.value))}
                  className="h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-950"
                />
                <select
                  value={payMethod}
                  onChange={(e) => setPayMethod(e.target.value as 'Cash' | 'UPI' | 'Card')}
                  className="h-8 px-2 border rounded bg-white dark:bg-neutral-950"
                >
                  <option value="Cash">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="Card">Card</option>
                </select>
              </div>
              {payMethod === 'UPI' && (
                <input
                  value={payUpiRef}
                  onChange={(e) => setPayUpiRef(e.target.value)}
                  placeholder="UPI Reference ID *"
                  className="w-full h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-950"
                />
              )}
              <Button
                size="sm"
                variant="primary"
                disabled={app.financialSummary.balanceDue <= 0}
                onClick={async () => {
                  try {
                    let paymentItem: ErpPaymentItem | null = null;
                    try {
                      const res = await erpApi.recordPayment({
                        applicationNo: app.applicationNo,
                        amount: payAmount,
                        paymentMethod: payMethod,
                        upiReference: payUpiRef,
                      });
                      paymentItem = res.data;
                    } catch (err) {
                      const msg = err instanceof Error ? err.message.toLowerCase() : '';
                      if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                      const nowIso = new Date().toISOString();
                      const txnId = `TXN${Date.now()}`;
                      paymentItem = {
                        id: Date.now(),
                        transactionId: txnId,
                        receiptNo: `MCR${Date.now().toString().slice(-6)}`,
                        applicationNo: app.applicationNo,
                        customerId: app.customerId,
                        customerName: app.customerSnapshot.fullName,
                        serviceId: app.serviceId,
                        serviceName: app.serviceSnapshot.name,
                        counterCode: app.assignedCounterCode || 'CTR-01',
                        collectedBy: currentUser.userId,
                        paymentType: payAmount >= app.financialSummary.balanceDue ? 'Full' : 'Partial',
                        paymentMethod: payMethod,
                        upiReference: payMethod === 'UPI' ? payUpiRef : undefined,
                        amount: Number(payAmount),
                        verificationStatus: payMethod === 'UPI' ? 'Pending Verification' : 'Confirmed',
                        verifiedBy: payMethod === 'UPI' ? null : currentUser.userId,
                        recordedAt: nowIso,
                        notes: 'Counter collection',
                      };
                    }
                    const updatedApp = await syncMutatedApp((prev) => {
                      const paid = prev.financialSummary.totalPaid + Number(paymentItem!.amount);
                      const net = paid - prev.financialSummary.totalRefunded;
                      const bal = Math.max(0, prev.financialSummary.serviceCharge - net);
                      return {
                        ...prev,
                        payments: [paymentItem!, ...prev.payments],
                        financialSummary: {
                          ...prev.financialSummary,
                          totalPaid: paid,
                          netCollected: net,
                          balanceDue: bal,
                          paymentStatus: bal <= 0 ? 'Paid' : 'Partial',
                        },
                        updatedAt: new Date().toISOString(),
                      };
                    });
                    await savePaymentToFirestore(paymentItem, updatedApp);
                    onShowToast('success', 'Receipt Issued & Saved', paymentItem.receiptNo);
                    onUpdated();
                  } catch (err) {
                    onShowToast('error', 'Payment Rejected', extractFriendlyErrorMessage(err));
                  }
                }}
              >
                Collect Payment &amp; Issue MCR Receipt
              </Button>

              <div className="divide-y divide-neutral-100 dark:divide-neutral-800 pt-2">
                {app.payments.map((p) => (
                  <div key={p.transactionId} className="py-1.5 flex justify-between">
                    <span>
                      <span className="font-mono font-semibold">{p.receiptNo}</span> ({p.paymentMethod} · {p.verificationStatus})
                    </span>
                    <span className="font-mono font-bold">{formatCurrency(p.amount)}</span>
                  </div>
                ))}
              </div>
            </div>

            {canApproveDocs && (
              <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-3">
                <div className="font-semibold text-sm">Issue Refund (MCRF Sequence · Over-Refund Guarded)</div>
                <select
                  value={refundTxnId}
                  onChange={(e) => setRefundTxnId(e.target.value)}
                  className="w-full h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-950"
                >
                  {app.payments.map((p) => (
                    <option key={p.transactionId} value={p.transactionId}>
                      {p.transactionId} · {p.receiptNo} ({formatCurrency(p.amount)})
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(Number(e.target.value))}
                    className="h-8 px-2 border rounded font-mono bg-white dark:bg-neutral-950"
                  />
                  <input
                    value={refundReason}
                    onChange={(e) => setRefundReason(e.target.value)}
                    placeholder="Refund reason *"
                    className="h-8 px-2 border rounded bg-white dark:bg-neutral-950"
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!refundTxnId}
                  onClick={async () => {
                    try {
                      let refundItem: ErpRefundItem | null = null;
                      try {
                        const res = await erpApi.createRefund({
                          applicationNo: app.applicationNo,
                          originalTransactionId: refundTxnId,
                          refundAmount,
                          refundMethod: 'Cash',
                          refundReason,
                        });
                        refundItem = res.data;
                      } catch (err) {
                        const msg = err instanceof Error ? err.message.toLowerCase() : '';
                        if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                        refundItem = {
                          id: Date.now(),
                          refundId: `MCRF${Date.now().toString().slice(-6)}`,
                          applicationNo: app.applicationNo,
                          customerId: app.customerId,
                          originalTransactionId: refundTxnId,
                          refundType: refundAmount >= app.financialSummary.netCollected ? 'Full' : 'Partial',
                          refundAmount: Number(refundAmount),
                          refundMethod: 'Cash',
                          refundReason: refundReason || 'Refund requested',
                          status: 'Pending',
                          requestedBy: currentUser.userId,
                          approvedBy: null,
                          processedBy: null,
                          createdAt: new Date().toISOString(),
                          processedAt: null,
                        };
                      }
                      const updatedApp = await syncMutatedApp((prev) => ({
                        ...prev,
                        refunds: [refundItem!, ...prev.refunds],
                        updatedAt: new Date().toISOString(),
                      }));
                      await saveRefundToFirestore(refundItem, updatedApp);
                      onShowToast('success', 'Refund Logged & Saved', `${refundItem.refundId} (${refundItem.status})`);
                      onUpdated();
                    } catch (err) {
                      onShowToast('error', 'Refund Blocked', extractFriendlyErrorMessage(err));
                    }
                  }}
                >
                  Request / Process Refund
                </Button>
                {app.refunds.map((r) => (
                  <div key={r.refundId} className="text-[11px] font-mono">
                    {r.refundId}: {formatCurrency(r.refundAmount)} · {r.status} ({r.refundReason})
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'delivery' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2.5">
              <div className="font-semibold text-sm flex items-center gap-2">
                <Truck className="h-4 w-4" />
                Customer Delivery &amp; Handover Tracking (MCD)
              </div>
              <input
                value={deliverableType}
                onChange={(e) => setDeliverableType(e.target.value)}
                placeholder="Deliverable Type"
                className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-950"
              />
              <select
                value={deliveryMethod}
                onChange={(e) => setDeliveryMethod(e.target.value)}
                className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-950"
              >
                <option value="Physical Handover">Physical Handover</option>
                <option value="Customer Collection">Customer Collection</option>
                <option value="Authorized Representative">Authorized Representative</option>
                <option value="Digital Delivery">Digital Delivery</option>
              </select>
              <input
                value={receivedBy}
                onChange={(e) => setReceivedBy(e.target.value)}
                placeholder="Received By Name *"
                className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-950"
              />
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={handoverConfirmed}
                  onChange={(e) => setHandoverConfirmed(e.target.checked)}
                />
                Customer Handover Acknowledgement Confirmed
              </label>
              <Button
                size="sm"
                variant="primary"
                onClick={async () => {
                  try {
                    let deliveryId = `MCD_${Date.now().toString().slice(-6)}`;
                    try {
                      const res = await erpApi.saveDelivery(app.applicationNo, {
                        deliverableType,
                        deliveryMethod,
                        receivedBy,
                        handoverConfirmed,
                        status: 'Delivered',
                      });
                      deliveryId = (res.data as { deliveryId: string }).deliveryId || deliveryId;
                    } catch (err) {
                      const msg = err instanceof Error ? err.message.toLowerCase() : '';
                      if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                    }
                    const nowIso = new Date().toISOString();
                    await syncMutatedApp((prev) => ({
                      ...prev,
                      delivery: {
                        deliveryId,
                        applicationNo: prev.applicationNo,
                        deliverableType,
                        deliverableDescription: deliverableType,
                        deliveryMethod,
                        deliveryDate: nowIso.slice(0, 10),
                        receivedBy,
                        handoverConfirmed,
                        acknowledgementRef: deliveryId,
                        status: 'Delivered',
                        remarks: '',
                      },
                      updatedAt: nowIso,
                    }));
                    const mappedDeliveryMode =
                      deliveryMethod === 'Digital Delivery'
                        ? 'Email Digital'
                        : 'In-Person Counter';
                    await saveDeliveryRecordToFirestore({
                      deliveryId,
                      applicationNo: app.applicationNo,
                      customerId: app.customerId,
                      customerName: app.customerSnapshot?.fullName || '',
                      recipientName: receivedBy || app.customerSnapshot?.fullName || 'Applicant',
                      recipientRelation:
                        deliveryMethod === 'Authorized Representative' ? 'Representative' : 'Self',
                      deliveryMode: mappedDeliveryMode,
                      deliveredBy: currentUser.userId,
                      deliveredAt: nowIso,
                      remarks: deliverableType,
                      status: 'Delivered',
                    });
                    onShowToast('success', 'Handover Recorded & Saved', deliveryId);
                    onUpdated();
                  } catch (err) {
                    onShowToast('error', 'Delivery Error', extractFriendlyErrorMessage(err));
                  }
                }}
              >
                Confirm Delivery Handover
              </Button>
              {app.delivery && (
                <div className="p-2 bg-neutral-50 dark:bg-neutral-950 border rounded font-mono text-[11px]">
                  {app.delivery.deliveryId} · {app.delivery.status} · Received by {app.delivery.receivedBy}
                </div>
              )}
            </div>

            <div className="border border-neutral-200 dark:border-neutral-800 rounded p-4 space-y-2.5">
              <div className="font-semibold text-sm">Cancellation Request Workflow</div>
              <input
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Mandatory cancellation reason *"
                className="w-full h-8 px-2 border rounded bg-white dark:bg-neutral-950"
              />
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  try {
                    try {
                      await erpApi.requestCancellation(app.applicationNo, cancelReason);
                    } catch (err) {
                      const msg = err instanceof Error ? err.message.toLowerCase() : '';
                      if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                    }
                    const nowIso = new Date().toISOString();
                    await syncMutatedApp((prev) => ({
                      ...prev,
                      cancellations: [
                        {
                          requestCode: `CAN_${Date.now().toString().slice(-6)}`,
                          reason: cancelReason,
                          requestedBy: currentUser.userId,
                          status: 'Pending',
                          reviewedBy: null,
                          createdAt: nowIso,
                        },
                        ...prev.cancellations,
                      ],
                      updatedAt: nowIso,
                    }));
                    setCancelReason('');
                    onShowToast('success', 'Cancellation Saved', 'Submitted for Manager/Admin review.');
                    onUpdated();
                  } catch (err) {
                    onShowToast('error', 'Cancellation Error', extractFriendlyErrorMessage(err));
                  }
                }}
              >
                Submit Cancellation Request
              </Button>
              {app.cancellations.map((c) => (
                <div key={c.requestCode} className="p-2 border rounded flex items-center justify-between">
                  <span>{c.requestCode}: {c.reason} ({c.status})</span>
                  {canApproveDocs && c.status === 'Pending' && (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={async () => {
                        try {
                          try {
                            await erpApi.reviewCancellation(c.requestCode, 'Approved', 'Approved via Profile');
                          } catch (err) {
                            const msg = err instanceof Error ? err.message.toLowerCase() : '';
                            if (!(msg.includes('not found') || msg.includes('404'))) throw err;
                          }
                          await syncMutatedApp((prev) => ({
                            ...prev,
                            status: 'Cancelled',
                            cancellations: prev.cancellations.map((item) =>
                              item.requestCode === c.requestCode
                                ? { ...item, status: 'Approved', reviewedBy: currentUser.userId }
                                : item
                            ),
                            updatedAt: new Date().toISOString(),
                          }));
                          onShowToast('success', 'Cancellation Approved & Saved');
                          onUpdated();
                        } catch (err) {
                          onShowToast('error', 'Approval Failed', extractFriendlyErrorMessage(err));
                        }
                      }}
                    >
                      Approve
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'print' && (
          <div className="space-y-3">
            <div className="p-6 border-2 border-neutral-950 rounded bg-white text-neutral-950 text-xs space-y-3">
              <div className="flex justify-between border-b border-neutral-300 pb-2">
                <div>
                  <div className="text-base font-bold">MUN COMPUTER — APPLICATION ACKNOWLEDGEMENT</div>
                  <div>Official Customer Copy (Internal Staff Notes Excluded)</div>
                </div>
                <div className="text-right font-mono">
                  <div className="font-bold">{app.applicationNo}</div>
                  <div>FY {app.financialYear}</div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div><strong>Customer:</strong> {app.customerSnapshot.fullName} ({app.customerId})</div>
                  <div><strong>Mobile:</strong> {app.customerSnapshot.mobile}</div>
                  <div><strong>Address:</strong> {app.customerSnapshot.presentAddress}</div>
                </div>
                <div>
                  <div><strong>Service:</strong> {app.serviceSnapshot.name}</div>
                  <div><strong>Status:</strong> {app.status} · Due {formatDateIST(app.expectedCompletionDate)}</div>
                  <div><strong>Total Fee:</strong> {formatCurrency(app.financialSummary.serviceCharge)} · Paid {formatCurrency(app.financialSummary.netCollected)}</div>
                </div>
              </div>
              <div>
                <strong>Customer-Facing Remarks:</strong>
                <ul className="list-disc pl-4 mt-1">
                  {app.notes.filter((n) => n.noteType === 'CUSTOMER_REMARK').length === 0 ? (
                    <li>No customer remarks recorded.</li>
                  ) : (
                    app.notes
                      .filter((n) => n.noteType === 'CUSTOMER_REMARK')
                      .map((n) => <li key={n.id}>{n.content}</li>)
                  )}
                </ul>
              </div>
              <div className="pt-2 border-t border-neutral-200 text-[10px] text-neutral-600">
                Disclaimer: MUN COMPUTER acts strictly as an authorized private digital &amp; filing assistance service centre. Statutory outcomes and department processing times depend solely on the concerned Government/External Authority.
              </div>
            </div>
            <div className="flex justify-end no-print">
              <Button size="sm" variant="primary" onClick={() => window.print()} icon={<Printer className="h-3.5 w-3.5" />}>
                Print A4 Acknowledgement
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
