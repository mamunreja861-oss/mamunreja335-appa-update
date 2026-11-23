import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Eye, Lock, Plus, Search, ShieldAlert, UserCheck, UserX } from 'lucide-react';
import { AccountStatus, PageKey, RoleName, UserProfile } from '../modules/types';
import { securityRequest, setAuthToken, setCsrfToken } from '../services/securityApi';
import { paginateArray } from '../services/apiClient';
import { Button } from '../components/Button';
import { MobileNumberInput } from '../components/MobileNumberInput';
import { DataTable, TableColumn } from '../components/DataTable';
import { StatusText } from '../components/StatusText';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  auth,
  extractFriendlyErrorMessage,
  getCurrentUserIdPrefix,
  updateFirebaseUserPasswordAndProfile,
} from '../services/firebase';
import { markPasswordChangedInFirestore } from '../services/cloudSync';

/* ============================================================================
 * 1. USER MANAGEMENT DIRECTORY
 * ========================================================================== */
interface UsersPageProps {
  currentUser: UserProfile;
  onNavigate: (page: PageKey) => void;
  onInspectProfile: (user: UserProfile) => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

export const UsersPage: React.FC<UsersPageProps> = ({
  currentUser,
  onNavigate,
  onInspectProfile,
  onShowToast,
}) => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<'ALL' | RoleName>('ALL');
  const [page, setPage] = useState(1);
  const [statusTarget, setStatusTarget] = useState<{
    user: UserProfile;
    nextStatus: AccountStatus;
  } | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await securityRequest<UserProfile[]>('/api/users');
      setUsers(res.data);
    } catch (err) {
      onShowToast('error', 'Failed to load users', extractFriendlyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [onShowToast]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      const matchesRole = roleFilter === 'ALL' || u.role === roleFilter;
      const matchesQuery =
        !q ||
        u.userId.toLowerCase().includes(q) ||
        u.fullName.toLowerCase().includes(q) ||
        u.mobile.toLowerCase().includes(q);
      return matchesRole && matchesQuery;
    });
  }, [users, query, roleFilter]);

  const paginated = useMemo(() => paginateArray(filtered, page, 6), [filtered, page]);

  const handleConfirmStatusChange = async () => {
    if (!statusTarget) return;
    try {
      await securityRequest(`/api/users/${statusTarget.user.userId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status: statusTarget.nextStatus }),
      });
      onShowToast(
        'success',
        'Account Status Updated',
        `${statusTarget.user.userId} is now ${statusTarget.nextStatus}.`
      );
      setStatusTarget(null);
      loadUsers();
    } catch (err) {
      onShowToast('error', 'Action Blocked', extractFriendlyErrorMessage(err));
      setStatusTarget(null);
    }
  };

  const columns: TableColumn<UserProfile>[] = [
    {
      key: 'userId',
      header: 'User ID',
      render: (r) => (
        <span className="font-mono text-xs font-semibold text-neutral-950 dark:text-white whitespace-nowrap">
          {r.userId}
        </span>
      ),
    },
    {
      key: 'fullName',
      header: 'Name & Department',
      render: (r) => (
        <div>
          <div className="font-medium text-neutral-950 dark:text-white flex items-center gap-1.5">
            <span>{r.fullName}</span>
            {r.isMasterAdmin && (
              <span className="font-mono text-[10px] px-1.5 py-0.5 border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/60 text-blue-900 dark:text-blue-300 rounded">
                MASTER
              </span>
            )}
          </div>
          <div className="text-xs font-mono text-neutral-500 dark:text-neutral-400">
            {r.mobile} · {r.departmentCode || 'DEPT-CSC'}{r.designation ? ` · ${r.designation}` : ''}
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Role',
      render: (r) => (
        <span className="text-xs font-semibold text-neutral-800 dark:text-neutral-200">{r.role}</span>
      ),
    },
    {
      key: 'aadhaar',
      header: 'Aadhaar',
      className: 'hidden md:table-cell',
      render: (r) => (
        <span className="font-mono text-xs text-neutral-500 dark:text-neutral-400">
          {r.aadhaarMasked ?? '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) => <StatusText status={r.isLocked ? 'SUSPENDED' : r.status} />,
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      render: (r) => (
        <div className="inline-flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button variant="outline" size="sm" onClick={() => onInspectProfile(r)}>
            Profile
          </Button>
          {r.userId !== currentUser.userId &&
            !r.isMasterAdmin &&
            (currentUser.role === 'ADMIN' || r.role === 'STAFF') && (
              <>
                {r.status === 'ACTIVE' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setStatusTarget({ user: r, nextStatus: 'SUSPENDED' })}
                    icon={<ShieldAlert className="h-3.5 w-3.5 text-red-600" />}
                  >
                    Suspend
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setStatusTarget({ user: r, nextStatus: 'ACTIVE' })}
                    icon={<UserCheck className="h-3.5 w-3.5 text-emerald-700" />}
                  >
                    Activate
                  </Button>
                )}
                {currentUser.role === 'ADMIN' && r.status !== 'DEACTIVATED' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setStatusTarget({ user: r, nextStatus: 'DEACTIVATED' })}
                    icon={<UserX className="h-3.5 w-3.5 text-neutral-500" />}
                  >
                    Deactivate
                  </Button>
                )}
              </>
            )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-neutral-950 dark:text-white">User Management</h2>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            Three-level identity directory · Immutable atomic User IDs (MCYYFFMMSSSS) &amp; Protected Master Admin
          </p>
        </div>
        <Button
          variant="primary"
          size="sm"
          onClick={() => onNavigate('add-user')}
          icon={<Plus className="h-3.5 w-3.5" />}
        >
          Add New User
        </Button>
      </div>

      <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="relative w-full sm:max-w-xs">
            <Search className="h-3.5 w-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              placeholder="Search User ID, name, mobile..."
              className="w-full h-9 pl-8 pr-3 text-xs bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md focus:outline-none focus:border-blue-800"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1">
            {(['ALL', 'ADMIN', 'MANAGER', 'STAFF', 'AUDITOR'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => {
                  setRoleFilter(r);
                  setPage(1);
                }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md cursor-pointer ${
                  roleFilter === r
                    ? 'bg-neutral-950 text-white dark:bg-white dark:text-neutral-950'
                    : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <DataTable
          columns={columns}
          data={paginated.items}
          rowKey={(u) => u.userId}
          loading={loading}
          pagination={paginated.pagination}
          onPageChange={setPage}
          onRowClick={onInspectProfile}
        />
      </div>

      <ConfirmDialog
        isOpen={Boolean(statusTarget)}
        onClose={() => setStatusTarget(null)}
        onConfirm={handleConfirmStatusChange}
        title={`Change Status to ${statusTarget?.nextStatus ?? ''}?`}
        description={`Confirm updating ${statusTarget?.user.fullName} (${statusTarget?.user.userId}) to ${statusTarget?.nextStatus}. Suspending or deactivating immediately revokes active sessions.`}
        confirmLabel={`Set ${statusTarget?.nextStatus ?? ''}`}
        variant={statusTarget?.nextStatus === 'ACTIVE' ? 'primary' : 'danger'}
      />
    </div>
  );
};

/* ============================================================================
 * 2. ADD NEW USER / REGISTER STAFF PAGE
 * ========================================================================== */
interface AddUserPageProps {
  currentUser: UserProfile;
  onNavigate: (page: PageKey) => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

export const AddUserPage: React.FC<AddUserPageProps> = ({
  currentUser,
  onNavigate,
  onShowToast,
}) => {
  const [role, setRole] = useState<'MANAGER' | 'STAFF' | 'AUDITOR'>('STAFF');
  const [prefixPreview, setPrefixPreview] = useState(() => getCurrentUserIdPrefix());
  const [fullName, setFullName] = useState('');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [branch, setBranch] = useState('Main Service Center');
  const [designation, setDesignation] = useState('CSC Counter Executive');
  const [departmentCode, setDepartmentCode] = useState('DEPT-CSC');
  const [joiningDate, setJoiningDate] = useState(new Date().toISOString().slice(0, 10));
  const [emergencyContact, setEmergencyContact] = useState('');
  const [departments, setDepartments] = useState<Array<{ code: string; name: string }>>([
    { code: 'DEPT-CSC', name: 'CSC Digital Service Center' },
    { code: 'DEPT-OPS', name: 'Front Desk & Operations' },
    { code: 'DEPT-FIN', name: 'Accounts & Finance Engine' },
    { code: 'DEPT-LEGAL', name: 'Documentation & Compliance' },
  ]);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [aadhaarNumber, setAadhaarNumber] = useState('');
  const [aadhaarConsent, setAadhaarConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    securityRequest<{ prefix: string }>(`/api/users/id-prefix-preview?role=${role}`)
      .then((res) => setPrefixPreview(res.data.prefix))
      .catch(() => setPrefixPreview(getCurrentUserIdPrefix()));
    securityRequest<Array<{ code: string; name: string }>>('/api/departments')
      .then((res) => {
        if (Array.isArray(res.data) && res.data.length > 0) setDepartments(res.data);
      })
      .catch(() => {});
  }, [role]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);

    try {
      const res = await securityRequest<{
        requiresApproval: boolean;
        user?: UserProfile;
        registrationRequest?: { requestId: string };
      }>('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          fullName: fullName.trim(),
          role,
          mobile: mobile.trim(),
          email: email.trim(),
          address: address.trim(),
          branch: branch.trim(),
          designation: designation.trim(),
          departmentCode,
          joiningDate,
          emergencyContact: emergencyContact.trim() || undefined,
          password: password.trim(),
          confirmPassword: confirmPassword.trim(),
          aadhaarNumber: aadhaarNumber.trim() || undefined,
          aadhaarConsent,
        }),
      });

      if (res.data.requiresApproval) {
        onShowToast(
          'info',
          'Submitted for Approval',
          `Request ${res.data.registrationRequest?.requestId} queued in Approval Management.`
        );
        onNavigate('approvals');
      } else {
        onShowToast(
          'success',
          'User Account Created',
          `Issued immutable ID ${res.data.user?.userId}.`
        );
        onNavigate('users');
      }
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to create user.');
      setFormError(msg);
      onShowToast('error', 'Provisioning Failed', msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-5">
      <div>
        <h2 className="text-xl font-bold text-neutral-950 dark:text-white">Add New User</h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
          {currentUser.role === 'ADMIN'
            ? 'Admin provisioning issues permanent User IDs immediately inside an atomic sequence transaction.'
            : 'Manager provisioning submits Staff registrations to the Approval Management workflow.'}
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 space-y-4"
      >
        {formError && (
          <div className="px-3.5 py-2.5 bg-red-50 dark:bg-red-950/50 border border-red-200 dark:border-red-900 rounded-md text-xs text-red-700 dark:text-red-300">
            {formError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Assigned Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'MANAGER' | 'STAFF' | 'AUDITOR')}
              disabled={currentUser.role !== 'ADMIN'}
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md disabled:bg-neutral-50 dark:disabled:bg-neutral-800"
            >
              <option value="STAFF">STAFF</option>
              {currentUser.role === 'ADMIN' && <option value="MANAGER">MANAGER</option>}
              {currentUser.role === 'ADMIN' && <option value="AUDITOR">AUDITOR (Read-Only)</option>}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Auto-Generated User ID Prefix
            </label>
            <input
              type="text"
              readOnly
              value={`${prefixPreview}XXXX`}
              className="w-full h-10 px-3 text-sm font-mono bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md text-neutral-700 dark:text-neutral-300"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Full Name *
            </label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Enter full legal name"
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Mobile Number *
            </label>
            <MobileNumberInput
              required
              heightClassName="h-10"
              value={mobile}
              onChange={setMobile}
              aria-label="Staff mobile number"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Email Address (Optional)
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@muncomputer.local"
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Branch
            </label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Department
            </label>
            <select
              value={departmentCode}
              onChange={(e) => setDepartmentCode(e.target.value)}
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            >
              {departments.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.code} — {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Designation
            </label>
            <input
              type="text"
              value={designation}
              onChange={(e) => setDesignation(e.target.value)}
              placeholder="e.g. CSC Operator"
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Joining Date
            </label>
            <input
              type="date"
              value={joiningDate}
              onChange={(e) => setJoiningDate(e.target.value)}
              className="w-full h-10 px-3 text-sm font-mono bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Address *
            </label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Full residential or branch address"
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Emergency Contact
            </label>
            <MobileNumberInput
              heightClassName="h-10"
              value={emergencyContact}
              onChange={setEmergencyContact}
              aria-label="Emergency contact number"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Strong Password (12+ chars, upper/lower/num/special) *
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
              Confirm Password *
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full h-10 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>
        </div>

        <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800">
          <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1.5">
            Aadhaar Number (Optional — Only collect if legally &amp; operationally required)
          </label>
          <input
            type="text"
            maxLength={14}
            value={aadhaarNumber}
            onChange={(e) => setAadhaarNumber(e.target.value)}
            placeholder="12-digit number (stored encrypted with AES-256-GCM)"
            className="w-full h-10 px-3 text-sm font-mono bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
          />
          {aadhaarNumber.trim().length > 0 && (
            <label className="mt-2 flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-300 cursor-pointer">
              <input
                type="checkbox"
                checked={aadhaarConsent}
                onChange={(e) => setAadhaarConsent(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Confirmed informed user consent for encrypted Aadhaar storage and masked display.
              </span>
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onNavigate('users')}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={submitting}>
            {currentUser.role === 'ADMIN' ? 'Create User Account' : 'Submit Registration Request'}
          </Button>
        </div>
      </form>
    </div>
  );
};

/* ============================================================================
 * 3. USER PROFILE PAGE
 * ========================================================================== */
interface UserProfilePageProps {
  viewer: UserProfile;
  targetUser: UserProfile;
  onProfileUpdated: (updated: UserProfile) => void;
  onShowToast: (type: 'success' | 'error' | 'info', title: string, description?: string) => void;
}

export const UserProfilePage: React.FC<UserProfilePageProps> = ({
  viewer,
  targetUser,
  onProfileUpdated,
  onShowToast,
}) => {
  const isSelf = viewer.userId === targetUser.userId;
  const canAdminSetPassword =
    !isSelf &&
    viewer.role === 'ADMIN' &&
    (!targetUser.isMasterAdmin || Boolean(viewer.isMasterAdmin));
  const [fullName, setFullName] = useState(targetUser.fullName);
  const [email, setEmail] = useState(targetUser.email);
  const [address, setAddress] = useState(targetUser.address);
  const [designation, setDesignation] = useState(targetUser.designation ?? '');
  const [emergencyContact, setEmergencyContact] = useState(targetUser.emergencyContact ?? '');
  const [revealedAadhaar, setRevealedAadhaar] = useState<string | null>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [adminNewPassword, setAdminNewPassword] = useState('');
  const [adminConfirmPassword, setAdminConfirmPassword] = useState('');
  const [requireChangeOnNextLogin, setRequireChangeOnNextLogin] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);
  const [savingAdminPassword, setSavingAdminPassword] = useState(false);
  const [passwordFeedback, setPasswordFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);
  const [adminPasswordFeedback, setAdminPasswordFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    setFullName(targetUser.fullName);
    setEmail(targetUser.email);
    setAddress(targetUser.address);
    setDesignation(targetUser.designation ?? '');
    setEmergencyContact(targetUser.emergencyContact ?? '');
    setRevealedAadhaar(null);
  }, [targetUser]);

  useEffect(() => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
    setAdminNewPassword('');
    setAdminConfirmPassword('');
    setRequireChangeOnNextLogin(false);
    setPasswordFeedback(null);
    setAdminPasswordFeedback(null);
  }, [targetUser.userId]);

  const validateStrongPasswordClient = (pwd: string): string | null => {
    if (pwd.length < 12) {
      return 'Strong Password Policy requires at least 12 characters.';
    }
    if (!/[A-Z]/.test(pwd) || !/[a-z]/.test(pwd) || !/[0-9]/.test(pwd) || !/[^A-Za-z0-9]/.test(pwd)) {
      return 'New password must include uppercase, lowercase, number, and symbol.';
    }
    return null;
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    try {
      const res = await securityRequest<UserProfile>(`/api/users/${targetUser.userId}`, {
        method: 'PUT',
        body: JSON.stringify({ fullName, email, address, designation, emergencyContact }),
      });
      onProfileUpdated({
        ...res.data,
        avatarInitials: targetUser.avatarInitials,
        permissions: targetUser.permissions,
      });
      onShowToast('success', 'Profile Saved', `Updated details for ${targetUser.userId}.`);
    } catch (err) {
      onShowToast('error', 'Update Failed', extractFriendlyErrorMessage(err));
    } finally {
      setSavingProfile(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordFeedback(null);
    const cleanCurrent = currentPassword.trim();
    const cleanNew = newPassword.trim();
    const cleanConfirm = confirmPassword.trim();
    if (!cleanCurrent) {
      const msg = 'Enter your current password.';
      setPasswordFeedback({ type: 'error', text: msg });
      onShowToast('error', 'Password Change Failed', msg);
      return;
    }
    const policyErr = validateStrongPasswordClient(cleanNew);
    if (policyErr) {
      setPasswordFeedback({ type: 'error', text: policyErr });
      onShowToast('error', 'Password Change Failed', policyErr);
      return;
    }
    if (cleanNew === cleanCurrent) {
      const msg = 'New password must be different from your current password.';
      setPasswordFeedback({ type: 'error', text: msg });
      onShowToast('error', 'Password Change Failed', msg);
      return;
    }
    if (cleanNew !== cleanConfirm) {
      const msg = 'New password and confirmation do not match.';
      setPasswordFeedback({ type: 'error', text: msg });
      onShowToast('error', 'Password Change Failed', msg);
      return;
    }
    setSavingPassword(true);
    try {
      const res = await securityRequest<{
        changed: boolean;
        csrfToken?: string;
        accessToken?: string;
        user?: UserProfile;
      }>(`/api/users/${encodeURIComponent(targetUser.userId)}/change-password`, {
        method: 'POST',
        body: JSON.stringify({
          currentPassword: cleanCurrent,
          newPassword: cleanNew,
          confirmPassword: cleanConfirm,
        }),
      });
      if (res.data?.csrfToken) {
        setCsrfToken(res.data.csrfToken);
      }
      if (res.data?.accessToken) {
        setAuthToken(res.data.accessToken);
      }
      const nextUserPayload: UserProfile = {
        ...targetUser,
        ...(res.data?.user ?? {}),
        mustChangePassword: false,
        passwordMigrationRequired: false,
        isFirstLogin: false,
        passwordChanged: true,
        avatarInitials: targetUser.avatarInitials,
        permissions: targetUser.permissions,
      };
      if (res.data?.user || res.data?.changed) {
        onProfileUpdated(nextUserPayload);
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      const successText = 'Password updated permanently. Use your new password for all future logins and password changes.';
      setPasswordFeedback({ type: 'success', text: successText });
      onShowToast('success', 'Password Updated', successText);

      if (viewer.userId === targetUser.userId && auth?.currentUser) {
        try {
          await updateFirebaseUserPasswordAndProfile({
            currentPassword: cleanCurrent,
            newPassword: cleanNew,
            displayName: nextUserPayload.fullName,
          });
          await markPasswordChangedInFirestore(auth.currentUser, nextUserPayload);
        } catch (fbErr) {
          console.warn('[Firebase Password Sync Warning]', fbErr);
        }
      }
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to update password.');
      setPasswordFeedback({ type: 'error', text: msg });
      onShowToast('error', 'Password Change Failed', msg);
    } finally {
      setSavingPassword(false);
    }
  };

  const handleAdminSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminPasswordFeedback(null);
    const cleanNew = adminNewPassword.trim();
    const cleanConfirm = adminConfirmPassword.trim();
    if (!cleanNew) {
      const msg = 'Enter a new strong password.';
      setAdminPasswordFeedback({ type: 'error', text: msg });
      onShowToast('error', 'Password Set Failed', msg);
      return;
    }
    const policyErr = validateStrongPasswordClient(cleanNew);
    if (policyErr) {
      setAdminPasswordFeedback({ type: 'error', text: policyErr });
      onShowToast('error', 'Password Set Failed', policyErr);
      return;
    }
    if (cleanNew !== cleanConfirm) {
      const msg = 'New password and confirmation do not match.';
      setAdminPasswordFeedback({ type: 'error', text: msg });
      onShowToast('error', 'Password Set Failed', msg);
      return;
    }
    setSavingAdminPassword(true);
    try {
      const res = await securityRequest<{
        updated: boolean;
        revokedSessions: number;
        user?: UserProfile;
      }>(`/api/users/${encodeURIComponent(targetUser.userId)}/set-password`, {
        method: 'POST',
        body: JSON.stringify({
          newPassword: cleanNew,
          confirmPassword: cleanConfirm,
          requireChangeOnNextLogin,
        }),
      });
      if (res.data?.user) {
        onProfileUpdated({
          ...targetUser,
          ...res.data.user,
          avatarInitials: targetUser.avatarInitials,
          permissions: targetUser.permissions,
        });
      }
      setAdminNewPassword('');
      setAdminConfirmPassword('');
      const successText = `Password saved permanently for ${targetUser.userId}. ${res.data?.revokedSessions ?? 0} active session(s) revoked.`;
      setAdminPasswordFeedback({ type: 'success', text: successText });
      onShowToast(
        'success',
        `Password Set for ${targetUser.userId}`,
        successText
      );
    } catch (err) {
      const msg = extractFriendlyErrorMessage(err, 'Unable to set user password.');
      setAdminPasswordFeedback({ type: 'error', text: msg });
      onShowToast('error', 'Password Set Failed', msg);
    } finally {
      setSavingAdminPassword(false);
    }
  };

  const handleRevealAadhaar = async () => {
    try {
      const res = await securityRequest<{ aadhaarFormatted: string }>(
        `/api/users/${targetUser.userId}/aadhaar`
      );
      setRevealedAadhaar(res.data.aadhaarFormatted);
      onShowToast('info', 'Authorized Aadhaar Access', 'Decryption event recorded in Audit Logs.');
    } catch (err) {
      onShowToast('error', 'Access Denied', extractFriendlyErrorMessage(err));
    }
  };

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-neutral-950 dark:text-white">User Profile</h2>
          <p className="text-xs font-mono text-neutral-500 dark:text-neutral-400 mt-1">
            {targetUser.userId} · {targetUser.role} · {targetUser.branch}
          </p>
        </div>
        <StatusText status={targetUser.status} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleSaveProfile}
          className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-neutral-950 dark:text-white">Identity &amp; Contact</h3>

          <div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
              Permanent User ID (Immutable)
            </label>
            <input
              type="text"
              readOnly
              value={targetUser.userId}
              className="w-full h-9 px-3 text-xs font-mono bg-neutral-50 dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md text-neutral-700 dark:text-neutral-300"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">Full Name</label>
            <input
              type="text"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">Address</label>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">Designation</label>
              <input
                type="text"
                value={designation}
                disabled={isSelf && viewer.role !== 'ADMIN'}
                onChange={(e) => setDesignation(e.target.value)}
                className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md disabled:bg-neutral-50 dark:disabled:bg-neutral-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">Emergency Contact</label>
              <MobileNumberInput
                value={emergencyContact}
                onChange={setEmergencyContact}
                aria-label="Emergency contact number"
              />
            </div>
          </div>

          {targetUser.hasAadhaar && (
            <div className="pt-2 border-t border-neutral-100 dark:border-neutral-800 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs text-neutral-500 dark:text-neutral-400">Aadhaar (Encrypted at Rest)</div>
                <div className="font-mono text-xs font-medium text-neutral-900 dark:text-neutral-100 mt-0.5">
                  {revealedAadhaar ?? targetUser.aadhaarMasked}
                </div>
              </div>
              {viewer.role === 'ADMIN' && !revealedAadhaar && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRevealAadhaar}
                  icon={<Eye className="h-3.5 w-3.5" />}
                >
                  Decrypt
                </Button>
              )}
            </div>
          )}

          <div className="pt-2">
            <Button type="submit" variant="primary" size="sm" loading={savingProfile}>
              Save Profile Changes
            </Button>
          </div>
        </form>

        {isSelf && (
          <form
            onSubmit={handleChangePassword}
            className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-5 space-y-4"
          >
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-neutral-700 dark:text-neutral-300" />
              <h3 className="text-sm font-semibold text-neutral-950 dark:text-white">Change Password</h3>
            </div>

            {passwordFeedback && (
              <div
                role={passwordFeedback.type === 'error' ? 'alert' : 'status'}
                className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                  passwordFeedback.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                    : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
                }`}
              >
                {passwordFeedback.type === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                ) : (
                  <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                )}
                <span>{passwordFeedback.text}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">
                Current Password
              </label>
              <input
                type="password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">
                New Strong Password (12+ chars, upper/lower/num/special)
              </label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">
                Confirm New Password
              </label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
              />
            </div>

            <Button type="submit" variant="secondary" size="sm" loading={savingPassword}>
              Update Password
            </Button>
          </form>
        )}

        {canAdminSetPassword && (
          <form
            onSubmit={handleAdminSetPassword}
            className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-5 space-y-4"
          >
            <div className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-blue-700 dark:text-blue-400" />
              <div>
                <h3 className="text-sm font-semibold text-neutral-950 dark:text-white">
                  Admin Set / Reset Password
                </h3>
                <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
                  Sets a new bcrypt-12 password for {targetUser.userId} and revokes active sessions.
                </p>
              </div>
            </div>

            {adminPasswordFeedback && (
              <div
                role={adminPasswordFeedback.type === 'error' ? 'alert' : 'status'}
                className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                  adminPasswordFeedback.type === 'success'
                    ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800 text-emerald-800 dark:text-emerald-200'
                    : 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-900 text-red-700 dark:text-red-300'
                }`}
              >
                {adminPasswordFeedback.type === 'success' ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
                ) : (
                  <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
                )}
                <span>{adminPasswordFeedback.text}</span>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">
                New Strong Password (12+ chars, upper/lower/num/special)
              </label>
              <input
                type="password"
                required
                value={adminNewPassword}
                onChange={(e) => setAdminNewPassword(e.target.value)}
                placeholder="e.g. StaffStrong#2026"
                className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-neutral-800 dark:text-neutral-200 mb-1">
                Confirm New Password
              </label>
              <input
                type="password"
                required
                value={adminConfirmPassword}
                onChange={(e) => setAdminConfirmPassword(e.target.value)}
                placeholder="Re-enter strong password"
                className="w-full h-9 px-3 text-sm bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-700 rounded-md"
              />
            </div>

            <label className="flex items-center gap-2 text-xs text-neutral-700 dark:text-neutral-300 cursor-pointer">
              <input
                type="checkbox"
                checked={requireChangeOnNextLogin}
                onChange={(e) => setRequireChangeOnNextLogin(e.target.checked)}
                className="rounded border-neutral-300"
              />
              <span>Require user to change password on next login</span>
            </label>

            <Button type="submit" variant="primary" size="sm" loading={savingAdminPassword}>
              Set User Password &amp; Revoke Sessions
            </Button>
          </form>
        )}
      </div>
    </div>
  );
};
