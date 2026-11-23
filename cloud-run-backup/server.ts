import 'dotenv/config';
import express, { Request, Response } from 'express';
import { BackupOrchestrator } from '../server/backup/backupOrchestrator.js';
import {
  createCloudSchedulerOidcMiddleware,
  createServiceSecretAuthMiddleware,
  SchedulerAuthConfig,
} from '../server/backup/oidcAuthMiddleware.js';
import { formatIstParts } from '../server/backup/backupProtection.js';
import { BackupComponentType } from '../server/backup/backupTypes.js';

export function createCloudRunBackupApp(options?: {
  orchestrator?: BackupOrchestrator;
  schedulerAuthConfig?: SchedulerAuthConfig;
  serviceAuthToken?: string;
}) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const orchestrator = options?.orchestrator ?? new BackupOrchestrator();
  if (process.env.NODE_ENV !== 'test') {
    void orchestrator.store.hydrateFromFirestore();
  }

  const verifySchedulerOidc = createCloudSchedulerOidcMiddleware(options?.schedulerAuthConfig);
  const verifyServiceAdmin = createServiceSecretAuthMiddleware(options?.serviceAuthToken);

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      success: true,
      service: 'mun-erp-firebase-backup-worker',
      timestamp: new Date().toISOString(),
    });
  });

  // ==========================================================================
  // Cloud Scheduler OIDC Authenticated Endpoints (Asia/Kolkata)
  // ==========================================================================
  app.post('/scheduler/firestore-backup', verifySchedulerOidc, async (req: Request, res: Response) => {
    const ist = formatIstParts(new Date());
    const idempotencyKey =
      String(req.headers['x-cloudscheduler-jobname'] || '').trim() ||
      `SCHED_FIRESTORE_${ist.year}-${ist.month}-${ist.day}`;
    try {
      const { record, deduplicated } = await orchestrator.runBackup({
        component: 'FIRESTORE',
        triggerType: 'SCHEDULER',
        triggeredBy: 'CLOUD_SCHEDULER_0200_IST',
        actorRole: 'CLOUD_SCHEDULER',
        idempotencyKey,
      });
      return res.status(record.status === 'SUCCESS' ? 200 : 500).json({
        success: record.status === 'SUCCESS',
        deduplicated,
        data: record,
      });
    } catch (err) {
      return res.status(409).json({
        success: false,
        message: err instanceof Error ? err.message : 'Scheduled Firestore backup skipped or failed.',
      });
    }
  });

  app.post('/scheduler/storage-backup', verifySchedulerOidc, async (req: Request, res: Response) => {
    const ist = formatIstParts(new Date());
    const idempotencyKey =
      String(req.headers['x-cloudscheduler-jobname'] || '').trim() ||
      `SCHED_STORAGE_${ist.year}-${ist.month}-${ist.day}`;
    try {
      const { record, deduplicated } = await orchestrator.runBackup({
        component: 'STORAGE',
        triggerType: 'SCHEDULER',
        triggeredBy: 'CLOUD_SCHEDULER_0230_IST',
        actorRole: 'CLOUD_SCHEDULER',
        idempotencyKey,
      });
      return res.status(record.status === 'SUCCESS' ? 200 : 500).json({
        success: record.status === 'SUCCESS',
        deduplicated,
        data: record,
      });
    } catch (err) {
      return res.status(409).json({
        success: false,
        message: err instanceof Error ? err.message : 'Scheduled Storage backup skipped or failed.',
      });
    }
  });

  app.post('/scheduler/complete-backup', verifySchedulerOidc, async (req: Request, res: Response) => {
    const ist = formatIstParts(new Date());
    const idempotencyKey =
      String(req.headers['x-cloudscheduler-jobname'] || '').trim() ||
      `SCHED_COMPLETE_${ist.year}-${ist.month}-${ist.day}`;
    try {
      const { record, deduplicated } = await orchestrator.runBackup({
        component: 'COMPLETE',
        triggerType: 'SCHEDULER',
        triggeredBy: 'CLOUD_SCHEDULER_COMPLETE',
        actorRole: 'CLOUD_SCHEDULER',
        idempotencyKey,
      });
      return res.status(record.status === 'SUCCESS' ? 200 : record.status === 'PARTIAL' ? 207 : 500).json({
        success: record.status === 'SUCCESS',
        deduplicated,
        data: record,
      });
    } catch (err) {
      return res.status(409).json({
        success: false,
        message: err instanceof Error ? err.message : 'Scheduled complete backup failed.',
      });
    }
  });

  app.post('/scheduler/retention-cleanup', verifySchedulerOidc, async (_req: Request, res: Response) => {
    const result = await orchestrator.runRetentionCleanup({
      userId: 'CLOUD_SCHEDULER_RETENTION',
      role: 'CLOUD_SCHEDULER',
    });
    return res.json({ success: true, data: result });
  });

  // ==========================================================================
  // Admin Service-to-Service Endpoints (called by Vercel ERP Admin Backend)
  // ==========================================================================
  app.get('/admin/dashboard', verifyServiceAdmin, async (_req: Request, res: Response) => {
    const telemetry = await orchestrator.getDashboardTelemetry();
    return res.json({ success: true, message: 'OK', data: telemetry });
  });

  app.put('/admin/config', verifyServiceAdmin, async (req: Request, res: Response) => {
    const actorId = String(req.headers['x-erp-actor-id'] || 'ADMIN');
    const actorRole = String(req.headers['x-erp-actor-role'] || 'ADMIN');
    const updated = await orchestrator.updateConfig(req.body ?? {}, {
      userId: actorId,
      role: actorRole,
    });
    return res.json({ success: true, message: 'Backup configuration saved.', data: updated });
  });

  app.post('/admin/run', verifyServiceAdmin, async (req: Request, res: Response) => {
    const actorId = String(req.headers['x-erp-actor-id'] || 'ADMIN');
    const actorRole = String(req.headers['x-erp-actor-role'] || 'ADMIN');
    const compRaw = req.body?.component;
    const component: BackupComponentType =
      compRaw === 'FIRESTORE' || compRaw === 'STORAGE' || compRaw === 'COMPLETE'
        ? compRaw
        : 'COMPLETE';
    try {
      const { record } = await orchestrator.runBackup({
        component,
        triggerType: 'MANUAL',
        triggeredBy: actorId,
        actorRole,
      });
      return res.status(record.status === 'FAILED' ? 500 : 200).json({
        success: record.status !== 'FAILED',
        message: `${component} backup finished: ${record.status}`,
        data: record,
      });
    } catch (err) {
      return res.status(409).json({
        success: false,
        message: err instanceof Error ? err.message : 'Backup execution failed.',
      });
    }
  });

  app.post('/admin/verify/:backupId', verifyServiceAdmin, async (req: Request, res: Response) => {
    const actorId = String(req.headers['x-erp-actor-id'] || 'ADMIN');
    const actorRole = String(req.headers['x-erp-actor-role'] || 'ADMIN');
    const updated = await orchestrator.verifyBackup(req.params.backupId, {
      userId: actorId,
      role: actorRole,
    });
    return res.json({ success: true, message: 'Verified.', data: updated });
  });

  app.get('/admin/manifest/:backupId', verifyServiceAdmin, async (req: Request, res: Response) => {
    const actorId = String(req.headers['x-erp-actor-id'] || 'ADMIN');
    const actorRole = String(req.headers['x-erp-actor-role'] || 'ADMIN');
    const manifest = await orchestrator.getAuthorizedManifest(req.params.backupId, {
      userId: actorId,
      role: actorRole,
    });
    return res.json({ success: true, message: 'OK', data: manifest });
  });

  app.post('/admin/retention/run', verifyServiceAdmin, async (req: Request, res: Response) => {
    const actorId = String(req.headers['x-erp-actor-id'] || 'ADMIN');
    const actorRole = String(req.headers['x-erp-actor-role'] || 'ADMIN');
    const result = await orchestrator.runRetentionCleanup({
      userId: actorId,
      role: actorRole,
    });
    return res.json({ success: true, message: 'OK', data: result });
  });

  app.post('/admin/restore/preview', verifyServiceAdmin, async (req: Request, res: Response) => {
    const actorId = String(req.headers['x-erp-actor-id'] || 'ADMIN');
    const actorRole = String(req.headers['x-erp-actor-role'] || 'ADMIN');
    const b = req.body ?? {};
    const preview = await orchestrator.previewRestore({
      backupId: String(b.backupId || ''),
      scope: b.scope === 'FIRESTORE' || b.scope === 'STORAGE' || b.scope === 'COMPLETE' ? b.scope : 'COMPLETE',
      selectedPaths: Array.isArray(b.selectedPaths) ? b.selectedPaths.map(String) : undefined,
      targetProjectId: typeof b.targetProjectId === 'string' ? b.targetProjectId : undefined,
      targetDatabaseId: typeof b.targetDatabaseId === 'string' ? b.targetDatabaseId : undefined,
      targetStorageBucket: typeof b.targetStorageBucket === 'string' ? b.targetStorageBucket : undefined,
      actor: { userId: actorId, role: actorRole },
    });
    return res.json({ success: true, message: 'OK', data: preview });
  });

  app.post('/admin/restore/execute', verifyServiceAdmin, async (req: Request, res: Response) => {
    const actorId = String(req.headers['x-erp-actor-id'] || 'ADMIN');
    const actorRole = String(req.headers['x-erp-actor-role'] || 'ADMIN');
    const b = req.body ?? {};
    const record = await orchestrator.executeRestore({
      previewId: String(b.previewId || ''),
      confirmationText: String(b.confirmationText || ''),
      actor: { userId: actorId, role: actorRole },
    });
    return res.json({ success: true, message: 'OK', data: record });
  });

  return app;
}

const isMainEntry =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  process.argv[1]?.includes('cloud-run-backup');

if (isMainEntry && process.env.NODE_ENV !== 'test') {
  const port = Number(process.env.PORT || 8080);
  const app = createCloudRunBackupApp();
  app.listen(port, '0.0.0.0', () => {
    console.log(`MUN COMPUTER ERP Firebase Backup Worker listening on port ${port}`);
  });
}
