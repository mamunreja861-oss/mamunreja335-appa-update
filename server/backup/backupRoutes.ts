import { Express, Request, RequestHandler, Response } from 'express';
import { ServerUser } from '../types.js';
import { BackupOrchestrator } from './backupOrchestrator.js';
import { BackupComponentType } from './backupTypes.js';

interface AuthedRequest extends Request {
  authUser?: ServerUser;
}

function ok(res: Response, data: unknown, message = 'OK', status = 200) {
  return res.status(status).json({
    success: true,
    message,
    data,
    meta: { timestamp: new Date().toISOString() },
  });
}

function fail(res: Response, message: string, status = 400) {
  return res.status(status).json({
    success: false,
    message,
    data: null,
    meta: { timestamp: new Date().toISOString() },
  });
}

function requireAdminOnly(req: AuthedRequest, res: Response): ServerUser | null {
  const actor = req.authUser;
  if (!actor || actor.role !== 'ADMIN') {
    fail(
      res,
      'Forbidden: Only Administrator accounts may access Firebase Cloud Backup, Manifest, or Restore controls.',
      403
    );
    return null;
  }
  return actor;
}

async function tryForwardToCloudRun<T>(
  subPath: string,
  method: string,
  body?: unknown,
  actor?: { userId: string; role: string }
): Promise<{ forwarded: boolean; status?: number; payload?: T }> {
  const cloudRunUrl = (process.env.BACKUP_CLOUD_RUN_URL || '').replace(/\/+$/, '').trim();
  const serviceToken = (process.env.BACKUP_SERVICE_AUTH_TOKEN || '').trim();
  if (!cloudRunUrl || !serviceToken || process.env.NODE_ENV === 'test') {
    return { forwarded: false };
  }
  const resp = await fetch(`${cloudRunUrl}${subPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-backup-service-token': serviceToken,
      ...(actor ? { 'x-erp-actor-id': actor.userId, 'x-erp-actor-role': actor.role } : {}),
    },
    ...(method !== 'GET' && body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = (await resp.json()) as T;
  return { forwarded: true, status: resp.status, payload };
}

export function registerFirebaseBackupRoutes(
  app: Express,
  requireAuth: RequestHandler,
  orchestrator: BackupOrchestrator = new BackupOrchestrator()
): BackupOrchestrator {
  const prefixes = ['/api/v1/security/firebase-backup', '/api/v1/backup'];

  for (const base of prefixes) {
    app.get(`${base}/dashboard`, requireAuth, async (req: AuthedRequest, res) => {
      const actor = requireAdminOnly(req, res);
      if (!actor) return;
      try {
        const forwarded = await tryForwardToCloudRun('/admin/dashboard', 'GET', undefined, actor);
        if (forwarded.forwarded) {
          return res.status(forwarded.status || 200).json(forwarded.payload);
        }
        const telemetry = await orchestrator.getDashboardTelemetry();
        return ok(res, telemetry, 'Firebase backup & restore telemetry loaded.');
      } catch (err) {
        return fail(res, err instanceof Error ? err.message : 'Unable to load backup telemetry.', 500);
      }
    });

    app.put(`${base}/config`, requireAuth, async (req: AuthedRequest, res) => {
      const actor = requireAdminOnly(req, res);
      if (!actor) return;
      try {
        const b = req.body ?? {};
        const forwarded = await tryForwardToCloudRun('/admin/config', 'PUT', b, actor);
        if (forwarded.forwarded) {
          return res.status(forwarded.status || 200).json(forwarded.payload);
        }
        const updated = await orchestrator.updateConfig(b, actor);
        return ok(res, updated, 'Automatic backup configuration updated.');
      } catch (err) {
        return fail(res, err instanceof Error ? err.message : 'Failed to update backup config.', 400);
      }
    });

    app.post(`${base}/run`, requireAuth, async (req: AuthedRequest, res) => {
      const actor = requireAdminOnly(req, res);
      if (!actor) return;
      const b = req.body ?? {};
      const component: BackupComponentType =
        b.component === 'FIRESTORE' || b.component === 'STORAGE' || b.component === 'COMPLETE'
          ? b.component
          : 'COMPLETE';
      try {
        const forwarded = await tryForwardToCloudRun('/admin/run', 'POST', { component }, actor);
        if (forwarded.forwarded) {
          return res.status(forwarded.status || 200).json(forwarded.payload);
        }
        const result = await orchestrator.runBackup({
          component,
          triggerType: 'MANUAL',
          triggeredBy: actor.userId,
          actorRole: actor.role,
          idempotencyKey: typeof b.idempotencyKey === 'string' ? b.idempotencyKey : undefined,
        });
        const statusCode =
          result.record.status === 'FAILED' ? 500 : result.record.status === 'PARTIAL' ? 207 : 201;
        return ok(
          res,
          result.record,
          `${component} backup completed with status ${result.record.status}.`,
          statusCode
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Backup execution failed.';
        const statusCode = msg.toLowerCase().includes('lock') ? 409 : 500;
        return fail(res, msg, statusCode);
      }
    });

    app.post(`${base}/:backupId/verify`, requireAuth, async (req: AuthedRequest, res) => {
      const actor = requireAdminOnly(req, res);
      if (!actor) return;
      try {
        const forwarded = await tryForwardToCloudRun(
          `/admin/verify/${encodeURIComponent(req.params.backupId)}`,
          'POST',
          {},
          actor
        );
        if (forwarded.forwarded) {
          return res.status(forwarded.status || 200).json(forwarded.payload);
        }
        const updated = await orchestrator.verifyBackup(req.params.backupId, actor);
        return ok(res, updated, `Backup ${updated.backupId} verified: ${updated.verificationStatus}.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Verification failed.';
        return fail(res, msg, msg.includes('not found') ? 404 : 400);
      }
    });

    app.get(`${base}/:backupId/manifest`, requireAuth, async (req: AuthedRequest, res) => {
      const actor = requireAdminOnly(req, res);
      if (!actor) return;
      try {
        const forwarded = await tryForwardToCloudRun(
          `/admin/manifest/${encodeURIComponent(req.params.backupId)}`,
          'GET',
          undefined,
          actor
        );
        if (forwarded.forwarded) {
          return res.status(forwarded.status || 200).json(forwarded.payload);
        }
        const manifest = await orchestrator.getAuthorizedManifest(req.params.backupId, actor);
        return ok(res, manifest, 'Authorized storage backup manifest loaded.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Manifest lookup failed.';
        return fail(res, msg, msg.includes('not found') ? 404 : 400);
      }
    });

    app.post(`${base}/retention/run`, requireAuth, async (req: AuthedRequest, res) => {
      const actor = requireAdminOnly(req, res);
      if (!actor) return;
      try {
        const forwarded = await tryForwardToCloudRun('/admin/retention/run', 'POST', {}, actor);
        if (forwarded.forwarded) {
          return res.status(forwarded.status || 200).json(forwarded.payload);
        }
        const result = await orchestrator.runRetentionCleanup(actor);
        return ok(res, result, 'Retention policy enforcement completed safely.');
      } catch (err) {
        return fail(res, err instanceof Error ? err.message : 'Retention check failed.', 500);
      }
    });

    app.post(`${base}/restore/preview`, requireAuth, async (req: AuthedRequest, res) => {
      const actor = requireAdminOnly(req, res);
      if (!actor) return;
      const b = req.body ?? {};
      const scope =
        b.scope === 'FIRESTORE' || b.scope === 'STORAGE' || b.scope === 'COMPLETE'
          ? b.scope
          : 'COMPLETE';
      try {
        const forwarded = await tryForwardToCloudRun('/admin/restore/preview', 'POST', b, actor);
        if (forwarded.forwarded) {
          return res.status(forwarded.status || 200).json(forwarded.payload);
        }
        const preview = await orchestrator.previewRestore({
          backupId: String(b.backupId || ''),
          scope,
          selectedPaths: Array.isArray(b.selectedPaths) ? b.selectedPaths.map(String) : undefined,
          targetProjectId: typeof b.targetProjectId === 'string' ? b.targetProjectId : undefined,
          targetDatabaseId: typeof b.targetDatabaseId === 'string' ? b.targetDatabaseId : undefined,
          targetStorageBucket:
            typeof b.targetStorageBucket === 'string' ? b.targetStorageBucket : undefined,
          actor,
        });
        return ok(res, preview, 'Restore dry-run preview generated.');
      } catch (err) {
        return fail(res, err instanceof Error ? err.message : 'Restore preview blocked.', 400);
      }
    });

    app.post(`${base}/restore/execute`, requireAuth, async (req: AuthedRequest, res) => {
      const actor = requireAdminOnly(req, res);
      if (!actor) return;
      const b = req.body ?? {};
      try {
        const forwarded = await tryForwardToCloudRun('/admin/restore/execute', 'POST', b, actor);
        if (forwarded.forwarded) {
          return res.status(forwarded.status || 200).json(forwarded.payload);
        }
        const record = await orchestrator.executeRestore({
          previewId: String(b.previewId || ''),
          confirmationText: String(b.confirmationText || ''),
          actor,
        });
        return ok(res, record, `Restore ${record.restoreId} completed (${record.status}).`);
      } catch (err) {
        return fail(res, err instanceof Error ? err.message : 'Restore failed.', 400);
      }
    });
  }

  return orchestrator;
}
