import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CreditCard, FileText, Plus, Printer, Receipt, Wallet } from 'lucide-react';
import {
  DailyCashClosingRecord,
  ErpExpenseItem,
  ErpPaymentItem,
  ErpRefundItem,
  PageKey,
  UserProfile,
} from '../../modules/types';
import { erpApi } from '../../services/erpApi';
import {
  saveExpenseToFirestore,
  savePaymentToFirestore,
  saveRefundToFirestore,
  subscribeExpensesFromFirestore,
  subscribePaymentsFromFirestore,
  subscribeRefundsFromFirestore,
} from '../../services/erpFirestore';
import {
  IncomeVoucherDoc,
  InvoiceDoc,
  ReceiptDoc,
  saveIncomeToFirestore,
  subscribeIncomeFromFirestore,
  subscribeInvoicesFromFirestore,
  subscribeReceiptsFromFirestore,
} from '../../services/erpLedgerFirestore';
import { useCloudSync } from '../../services/cloudSync';
import { extractFriendlyErrorMessage } from '../../services/firebase';
import { Button } from '../../components/Button';
import { Modal } from '../../components/Modal';
import { formatCurrency } from '../../services/apiClient';
import { formatDateIST, getTodayIsoIST } from '../../services/formatters';

interface FinancialLedgerPageProps {
  currentUser: UserProfile;
  mode: 'transactions' | 'cashbook' | 'expenses' | 'income';
  dailyCashClosings: DailyCashClosingRecord[];
  onNavigate?: (page: PageKey) => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

export const FinancialLedgerPage: React.FC<FinancialLedgerPageProps> = ({
  currentUser,
  mode,
  dailyCashClosings,
  onNavigate,
  onShowToast,
}) => {
  const [basePayments, setBasePayments] = useState<ErpPaymentItem[]>([]);
  const [baseRefunds, setBaseRefunds] = useState<ErpRefundItem[]>([]);
  const [baseExpenses, setBaseExpenses] = useState<ErpExpenseItem[]>([]);
  const [baseIncome, setBaseIncome] = useState<IncomeVoucherDoc[]>([]);
  const [cloudPayments, setCloudPayments] = useState<ErpPaymentItem[]>([]);
  const [cloudRefunds, setCloudRefunds] = useState<ErpRefundItem[]>([]);
  const [cloudExpenses, setCloudExpenses] = useState<ErpExpenseItem[]>([]);
  const [cloudInvoices, setCloudInvoices] = useState<InvoiceDoc[]>([]);
  const [cloudReceipts, setCloudReceipts] = useState<ReceiptDoc[]>([]);
  const [cloudIncome, setCloudIncome] = useState<IncomeVoucherDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingExp, setSavingExp] = useState(false);
  const [savingInc, setSavingInc] = useState(false);

  const [expModalOpen, setExpModalOpen] = useState(false);
  const [expForm, setExpForm] = useState({
    category: 'Office Utilities',
    description: '',
    counterCode: 'CTR-01',
    amount: 0,
  });

  const [incModalOpen, setIncModalOpen] = useState(false);
  const [incForm, setIncForm] = useState({
    category: 'Printing & Lamination',
    description: '',
    counterCode: 'CTR-01',
    paymentMethod: 'Cash',
    amount: 0,
  });

  const [printReceipt, setPrintReceipt] = useState<ErpPaymentItem | null>(null);
  const cloudSync = useCloudSync();

  const loadFinance = useCallback(async () => {
    setLoading(true);
    try {
      const [res, incRes] = await Promise.all([
        erpApi.getFinanceLedger(),
        erpApi.listIncome().catch(() => ({ data: [] as IncomeVoucherDoc[] })),
      ]);
      setBasePayments(res.data.payments);
      setBaseRefunds(res.data.refunds);
      setBaseExpenses(res.data.expenses);
      setBaseIncome(incRes.data);
    } catch (err) {
      if (!cloudSync.userUid) {
        onShowToast('error', 'Finance Load Failed', extractFriendlyErrorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  }, [cloudSync.userUid, onShowToast]);

  useEffect(() => {
    void loadFinance();
  }, [loadFinance]);

  useEffect(() => {
    if (!cloudSync.userUid) return;
    const onSubError = (label: string) => (err: unknown) => {
      onShowToast('error', `${label} Sync Error`, extractFriendlyErrorMessage(err));
    };
    const unsubPay = subscribePaymentsFromFirestore(setCloudPayments, onSubError('Payments'));
    const unsubRef = subscribeRefundsFromFirestore(setCloudRefunds, onSubError('Refunds'));
    const unsubExp = subscribeExpensesFromFirestore(setCloudExpenses, onSubError('Expenses'));
    const unsubInv = subscribeInvoicesFromFirestore(setCloudInvoices, onSubError('Invoices'));
    const unsubRcpt = subscribeReceiptsFromFirestore(setCloudReceipts, onSubError('Receipts'));
    const unsubInc = subscribeIncomeFromFirestore(setCloudIncome, onSubError('Income'));
    return () => {
      unsubPay();
      unsubRef();
      unsubExp();
      unsubInv();
      unsubRcpt();
      unsubInc();
    };
  }, [cloudSync.userUid, onShowToast]);

  const payments = useMemo(() => {
    const map = new Map<string, ErpPaymentItem>();
    for (const p of basePayments) map.set(p.transactionId, p);
    for (const p of cloudPayments) map.set(p.transactionId, p);
    return Array.from(map.values()).sort((a, b) =>
      String(b.recordedAt || '').localeCompare(String(a.recordedAt || ''))
    );
  }, [basePayments, cloudPayments]);

  const refunds = useMemo(() => {
    const map = new Map<string, ErpRefundItem>();
    for (const r of baseRefunds) map.set(r.refundId, r);
    for (const r of cloudRefunds) map.set(r.refundId, r);
    return Array.from(map.values()).sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );
  }, [baseRefunds, cloudRefunds]);

  const expenses = useMemo(() => {
    const map = new Map<string, ErpExpenseItem>();
    for (const e of baseExpenses) map.set(e.voucherNo, e);
    for (const e of cloudExpenses) map.set(e.voucherNo, e);
    return Array.from(map.values()).sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );
  }, [baseExpenses, cloudExpenses]);

  const incomeVouchers = useMemo(() => {
    const map = new Map<string, IncomeVoucherDoc>();
    for (const inc of baseIncome) map.set(inc.incomeNo, inc);
    for (const inc of cloudIncome) map.set(inc.incomeNo, inc);
    return Array.from(map.values()).sort((a, b) =>
      String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
    );
  }, [baseIncome, cloudIncome]);

  const directIncomeTotal = useMemo(
    () => incomeVouchers.filter((i) => i.status !== 'Pending').reduce((s, i) => s + Number(i.amount || 0), 0),
    [incomeVouchers]
  );

  const totalCollected =
    payments
      .filter((p) => p.verificationStatus === 'Confirmed')
      .reduce((s, p) => s + p.amount, 0) + directIncomeTotal;
  const totalRefunded = refunds
    .filter((r) => r.status === 'Processed')
    .reduce((s, r) => s + r.refundAmount, 0);
  const totalExpenses = expenses.reduce((s, e) => s + e.amount, 0);
  const netCashbook = totalCollected - totalRefunded - totalExpenses;

  const canManage = currentUser.role === 'ADMIN' || currentUser.role === 'MANAGER';
  const isAuditor = currentUser.role === 'AUDITOR';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-neutral-950 dark:text-white capitalize">
            {mode === 'transactions'
              ? 'Transactions, Receipts & Refunds'
              : mode === 'cashbook'
                ? 'Counter Cashbook & Reconciliation'
                : mode === 'expenses'
                  ? 'Expenses & Disbursement Vouchers'
                  : 'Service Income & Net Revenue'}
          </h2>
          <p className="text-xs text-neutral-500 mt-1">
            Linked strictly to MCA Applications, MCR Receipts, MCI Invoices, MCRF Refund Guards &amp; Double-Entry General Ledger
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {onNavigate && (
            <>
              <Button size="sm" variant="outline" onClick={() => onNavigate('chart-of-accounts')}>
                GL Vouchers &amp; CoA
              </Button>
              <Button size="sm" variant="outline" onClick={() => onNavigate('banking-csp')}>
                PNB CSP Isolated Desk
              </Button>
            </>
          )}
          {!isAuditor && mode === 'income' && (
            <Button size="sm" variant="primary" onClick={() => setIncModalOpen(true)} icon={<Plus className="h-3.5 w-3.5" />}>
              Log Income Voucher
            </Button>
          )}
          {!isAuditor && (mode === 'expenses' || mode === 'cashbook') && (
            <Button size="sm" variant="primary" onClick={() => setExpModalOpen(true)} icon={<Plus className="h-3.5 w-3.5" />}>
              Log Expense Voucher
            </Button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="text-neutral-500 flex items-center justify-between">
            <span>Confirmed Collections &amp; Income</span>
            <CreditCard className="h-4 w-4 text-emerald-600" />
          </div>
          <div className="mt-2 text-lg font-bold font-mono">{formatCurrency(totalCollected)}</div>
          <div className="mt-1 text-[11px] text-neutral-500">
            Includes {incomeVouchers.length} direct income voucher(s) · {cloudInvoices.length} invoice(s)
          </div>
        </div>
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="text-neutral-500 flex items-center justify-between">
            <span>Processed Refunds</span>
            <Receipt className="h-4 w-4 text-amber-600" />
          </div>
          <div className="mt-2 text-lg font-bold font-mono">{formatCurrency(totalRefunded)}</div>
          <div className="mt-1 text-[11px] text-neutral-500">{cloudReceipts.length} cloud receipt(s)</div>
        </div>
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="text-neutral-500 flex items-center justify-between">
            <span>Operating Expenses</span>
            <Wallet className="h-4 w-4 text-neutral-500" />
          </div>
          <div className="mt-2 text-lg font-bold font-mono">{formatCurrency(totalExpenses)}</div>
        </div>
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-4">
          <div className="text-neutral-500">Net Ledger Balance</div>
          <div className="mt-2 text-lg font-bold font-mono text-neutral-950 dark:text-white">
            {formatCurrency(netCashbook)}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="p-6 text-xs text-neutral-500">Loading financial records...</div>
      ) : (mode === 'transactions' || mode === 'income') ? (
        <div className="space-y-4">
          {incomeVouchers.length > 0 && (
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-xs font-semibold flex items-center justify-between">
                <span>Direct Service &amp; Counter Income Vouchers ({incomeVouchers.length})</span>
                <span className="font-mono text-emerald-700 dark:text-emerald-400">{formatCurrency(directIncomeTotal)}</span>
              </div>
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-xs">
                {incomeVouchers.map((inc) => (
                  <div key={inc.incomeNo} className="p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-mono font-bold">
                        {inc.incomeNo} · {inc.category}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-300">
                        {inc.description} ({inc.paymentMethod}) · Counter {inc.counterCode}
                      </div>
                      <div className="text-[11px] text-neutral-500">
                        Status: {inc.status} · Date {formatDateIST(inc.incomeDate)} · By {inc.recordedBy}
                      </div>
                    </div>
                    <div className="font-mono font-bold text-sm text-emerald-700 dark:text-emerald-400">
                      {formatCurrency(inc.amount)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-xs font-semibold">
              Payment Receipts &amp; Tax Invoices ({payments.length})
            </div>
            <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-xs">
              {payments.map((p) => (
                <div key={p.transactionId} className="p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="font-mono font-bold">
                      {p.receiptNo} {p.invoiceNo ? `· ${p.invoiceNo}` : ''} · {p.applicationNo}
                    </div>
                    <div className="text-neutral-600 dark:text-neutral-300">
                      {p.customerName} — {p.serviceName} ({p.paymentMethod}{p.upiReference ? ` · ${p.upiReference}` : ''})
                    </div>
                    <div className="text-[11px] text-neutral-500">
                      Status: {p.verificationStatus} · Counter {p.counterCode} · {formatDateIST(p.recordedAt.slice(0, 10))}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-sm">{formatCurrency(p.amount)}</span>
                    {canManage && p.verificationStatus === 'Pending Verification' && (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<CheckCircle2 className="h-3 w-3" />}
                        onClick={async () => {
                          try {
                            let updated: ErpPaymentItem | null = null;
                            try {
                              const res = await erpApi.verifyPayment(p.transactionId, 'Confirmed');
                              updated = res.data;
                            } catch (apiErr) {
                              const msg = apiErr instanceof Error ? apiErr.message.toLowerCase() : '';
                              if (!(msg.includes('not found') || msg.includes('404'))) throw apiErr;
                              updated = {
                                ...p,
                                verificationStatus: 'Confirmed',
                                verifiedBy: currentUser.userId,
                              };
                            }
                            const saved = await savePaymentToFirestore(updated);
                            setCloudPayments((prev) => [
                              saved,
                              ...prev.filter((item) => item.transactionId !== saved.transactionId),
                            ]);
                            onShowToast('success', 'UPI Settlement Verified & Saved');
                          } catch (err) {
                            onShowToast('error', 'Verification Failed', extractFriendlyErrorMessage(err));
                          }
                        }}
                      >
                        Verify UPI
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      icon={<Printer className="h-3 w-3" />}
                      onClick={() => setPrintReceipt(p)}
                    >
                      A4 Print
                    </Button>
                  </div>
                </div>
              ))}
              {payments.length === 0 && (
                <div className="p-6 text-center text-neutral-500">
                  No payment receipts recorded yet.
                </div>
              )}
            </div>
          </div>

          {cloudInvoices.length > 0 && (
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-xs font-semibold flex items-center gap-1.5">
                <FileText className="h-3.5 w-3.5 text-neutral-500" />
                <span>Synced Tax &amp; Service Invoices ({cloudInvoices.length})</span>
              </div>
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-xs">
                {cloudInvoices.map((inv) => (
                  <div key={inv.invoiceNo} className="p-3 sm:p-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-mono font-bold">
                        {inv.invoiceNo} · {inv.applicationNo}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-300">
                        {inv.customerName} ({inv.customerId}) — {inv.serviceName}
                      </div>
                      <div className="text-[11px] text-neutral-500">
                        Status: {inv.status} · Issued {formatDateIST(inv.issuedDate)}
                      </div>
                    </div>
                    <div className="text-right font-mono">
                      <div className="font-bold">{formatCurrency(inv.totalAmount)}</div>
                      <div className="text-[11px] text-neutral-500">
                        Paid {formatCurrency(inv.paidAmount)} · Due {formatCurrency(inv.balanceDue)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {refunds.length > 0 && (
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 text-xs font-semibold">
                Cancellation Refunds ({refunds.length})
              </div>
              <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-xs">
                {refunds.map((r) => (
                  <div key={r.refundId} className="p-3 flex items-center justify-between">
                    <div>
                      <span className="font-mono font-bold">{r.refundId}</span> · {r.applicationNo} · {r.refundReason} ({r.status})
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold">{formatCurrency(r.refundAmount)}</span>
                      {currentUser.role === 'ADMIN' && r.status === 'Pending' && (
                        <Button
                          size="sm"
                          variant="primary"
                          onClick={async () => {
                            try {
                              let updated: ErpRefundItem | null = null;
                              try {
                                const res = await erpApi.processRefund(r.refundId, 'Processed');
                                updated = res.data;
                              } catch (apiErr) {
                                const msg = apiErr instanceof Error ? apiErr.message.toLowerCase() : '';
                                if (!(msg.includes('not found') || msg.includes('404'))) throw apiErr;
                                updated = {
                                  ...r,
                                  status: 'Processed',
                                  approvedBy: r.approvedBy || currentUser.userId,
                                  processedBy: currentUser.userId,
                                  processedAt: new Date().toISOString(),
                                };
                              }
                              const saved = await saveRefundToFirestore(updated);
                              setCloudRefunds((prev) => [
                                saved,
                                ...prev.filter((item) => item.refundId !== saved.refundId),
                              ]);
                              onShowToast('success', 'Refund Processed & Saved', r.refundId);
                            } catch (err) {
                              onShowToast('error', 'Refund Failed', extractFriendlyErrorMessage(err));
                            }
                          }}
                        >
                          Process Refund
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : mode === 'expenses' ? (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg divide-y divide-neutral-100 dark:divide-neutral-800 text-xs">
          {expenses.map((e) => (
            <div key={e.voucherNo} className="p-4 flex items-center justify-between">
              <div>
                <div className="font-mono font-bold">{e.voucherNo} · {e.category}</div>
                <div className="text-neutral-500">{e.description} · Counter {e.counterCode} · By {e.recordedBy}</div>
              </div>
              <div className="font-mono font-bold text-sm">{formatCurrency(e.amount)}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg divide-y divide-neutral-100 dark:divide-neutral-800 text-xs">
          <div className="p-4 font-semibold">Daily Cash Closing &amp; Counter Reconciliation</div>
          {dailyCashClosings.map((c) => (
            <div key={c.closingCode} className="p-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-mono font-bold">{c.closingCode} · {c.counterCode} ({c.closingDate})</div>
                <div className="text-neutral-500">
                  Opening {formatCurrency(c.openingCash)} + Received {formatCurrency(c.cashReceived)} − Expenses {formatCurrency(c.cashExpenses)} = Expected {formatCurrency(c.expectedCash)}
                </div>
              </div>
              <div className="text-right font-mono">
                <div className="font-bold">Actual: {formatCurrency(c.actualCashCount)}</div>
                <div className="text-neutral-500">{c.approvalStatus}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Direct Income Voucher Modal */}
      <Modal isOpen={incModalOpen} onClose={() => setIncModalOpen(false)} title="Record Direct Income Voucher">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSavingInc(true);
            try {
              const apiRes = await erpApi.createIncome({
                category: incForm.category.trim() || 'Service Income',
                description: incForm.description.trim() || 'Counter Income',
                counterCode: incForm.counterCode.trim() || 'CTR-01',
                paymentMethod: incForm.paymentMethod,
                amount: Number(incForm.amount),
                incomeDate: getTodayIsoIST(),
              });
              const saved = await saveIncomeToFirestore(apiRes.data).catch(() => apiRes.data);
              setBaseIncome((prev) => [saved, ...prev.filter((item) => item.incomeNo !== saved.incomeNo)]);
              setCloudIncome((prev) => [saved, ...prev.filter((item) => item.incomeNo !== saved.incomeNo)]);
              setIncModalOpen(false);
              setIncForm({
                category: 'Printing & Lamination',
                description: '',
                counterCode: 'CTR-01',
                paymentMethod: 'Cash',
                amount: 0,
              });
              onShowToast('success', 'Income Voucher Saved', saved.incomeNo);
            } catch (err) {
              onShowToast('error', 'Income Recording Failed', extractFriendlyErrorMessage(err));
            } finally {
              setSavingInc(false);
            }
          }}
          className="space-y-3 text-xs"
        >
          <input
            required
            value={incForm.category}
            onChange={(e) => setIncForm({ ...incForm, category: e.target.value })}
            placeholder="Income Category (e.g. Printing & Lamination)"
            className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950"
          />
          <input
            required
            value={incForm.description}
            onChange={(e) => setIncForm({ ...incForm, description: e.target.value })}
            placeholder="Description"
            className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950"
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              type="number"
              required
              min={1}
              value={incForm.amount}
              onChange={(e) => setIncForm({ ...incForm, amount: Number(e.target.value) })}
              placeholder="Amount (₹)"
              className="h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
            />
            <select
              value={incForm.paymentMethod}
              onChange={(e) => setIncForm({ ...incForm, paymentMethod: e.target.value })}
              className="h-9 px-2 border rounded bg-white dark:bg-neutral-950"
            >
              <option value="Cash">Cash</option>
              <option value="UPI">UPI</option>
              <option value="Card">Card</option>
              <option value="Bank Transfer">Bank Transfer</option>
            </select>
            <input
              value={incForm.counterCode}
              onChange={(e) => setIncForm({ ...incForm, counterCode: e.target.value })}
              className="h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setIncModalOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" variant="primary" loading={savingInc}>Save Income Voucher</Button>
          </div>
        </form>
      </Modal>

      {/* Expense Modal */}
      <Modal isOpen={expModalOpen} onClose={() => setExpModalOpen(false)} title="Record Expense Voucher">
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setSavingExp(true);
            try {
              const res = await erpApi.createExpense(expForm);
              const saved = await saveExpenseToFirestore(res.data);
              setCloudExpenses((prev) => [
                saved,
                ...prev.filter((item) => item.voucherNo !== saved.voucherNo),
              ]);
              setExpModalOpen(false);
              setExpForm({ category: 'Office Utilities', description: '', counterCode: 'CTR-01', amount: 0 });
              onShowToast('success', 'Expense Voucher Saved to Cloud', saved.voucherNo);
            } catch (err) {
              onShowToast('error', 'Expense Recording Failed', extractFriendlyErrorMessage(err));
            } finally {
              setSavingExp(false);
            }
          }}
          className="space-y-3 text-xs"
        >
          <input
            required
            value={expForm.category}
            onChange={(e) => setExpForm({ ...expForm, category: e.target.value })}
            placeholder="Expense Category"
            className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950"
          />
          <input
            required
            value={expForm.description}
            onChange={(e) => setExpForm({ ...expForm, description: e.target.value })}
            placeholder="Description"
            className="w-full h-9 px-3 border rounded bg-white dark:bg-neutral-950"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number"
              required
              min={1}
              value={expForm.amount}
              onChange={(e) => setExpForm({ ...expForm, amount: Number(e.target.value) })}
              placeholder="Amount (₹)"
              className="h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
            />
            <input
              value={expForm.counterCode}
              onChange={(e) => setExpForm({ ...expForm, counterCode: e.target.value })}
              className="h-9 px-3 border rounded font-mono bg-white dark:bg-neutral-950"
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="outline" onClick={() => setExpModalOpen(false)}>Cancel</Button>
            <Button type="submit" size="sm" variant="primary" loading={savingExp}>Save Voucher</Button>
          </div>
        </form>
      </Modal>

      {/* Receipt Print Preview */}
      <Modal
        isOpen={Boolean(printReceipt)}
        onClose={() => setPrintReceipt(null)}
        title={`A4 Print Preview · ${printReceipt?.receiptNo}`}
      >
        {printReceipt && (
          <div className="space-y-4">
            <div className="p-6 border-2 border-neutral-950 rounded bg-white text-neutral-950 text-xs space-y-3">
              <div className="flex justify-between border-b border-neutral-300 pb-2">
                <div>
                  <div className="font-bold text-sm">MUN COMPUTER — OFFICIAL PAYMENT RECEIPT</div>
                  <div>Mamudpur, Juginda, Domkal, Murshidabad, WB - 742406</div>
                </div>
                <div className="text-right font-mono">
                  <div className="font-bold">{printReceipt.receiptNo}</div>
                  {printReceipt.invoiceNo && <div>Invoice: {printReceipt.invoiceNo}</div>}
                </div>
              </div>
              <div>Customer: <strong>{printReceipt.customerName}</strong> ({printReceipt.customerId})</div>
              <div>Application: <strong className="font-mono">{printReceipt.applicationNo}</strong> — {printReceipt.serviceName}</div>
              <div>Method: {printReceipt.paymentMethod} · Counter {printReceipt.counterCode}</div>
              <div className="text-base font-bold font-mono pt-2 border-t border-neutral-200">
                Amount Settled: {formatCurrency(printReceipt.amount)}
              </div>
            </div>
            <div className="flex justify-end no-print">
              <Button size="sm" variant="primary" onClick={() => window.print()} icon={<Printer className="h-3.5 w-3.5" />}>
                Print A4 Receipt
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

