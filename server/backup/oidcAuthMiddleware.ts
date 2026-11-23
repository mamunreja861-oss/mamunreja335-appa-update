import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';
import { OAuth2Client } from 'google-auth-library';

export interface OidcClaims {
  email?: string;
  email_verified?: boolean;
  aud?: string | string[];
  iss?: string;
  sub?: string;
}

export interface SchedulerAuthConfig {
  expectedAudience?: string;
  expectedServiceAccountEmail?: string;
  serviceAuthToken?: string;
  verifyOidcToken?: (idToken: string, expectedAudience: string) => Promise<OidcClaims>;
}

const defaultOAuth2Client = new OAuth2Client();

export async function verifyGoogleOidcJwt(
  idToken: string,
  expectedAudience: string
): Promise<OidcClaims> {
  const ticket = await defaultOAuth2Client.verifyIdToken({
    idToken,
    audience: expectedAudience,
  });
  const payload = ticket.getPayload();
  if (!payload) {
    throw new Error('OIDC ID token payload is empty.');
  }
  return {
    email: payload.email,
    email_verified: payload.email_verified,
    aud: payload.aud,
    iss: payload.iss,
    sub: payload.sub,
  };
}

export function timingSafeTokenEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createCloudSchedulerOidcMiddleware(config: SchedulerAuthConfig = {}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = String(req.headers.authorization || '').trim();
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Missing OIDC Bearer token from Cloud Scheduler.',
      });
    }
    const token = authHeader.slice(7).trim();
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Empty Bearer token.',
      });
    }

    const expectedAudience = (
      config.expectedAudience ||
      process.env.CLOUD_SCHEDULER_AUDIENCE ||
      process.env.BACKUP_CLOUD_RUN_URL ||
      ''
    ).trim();
    const expectedSa = (
      config.expectedServiceAccountEmail ||
      process.env.CLOUD_SCHEDULER_SA_EMAIL ||
      ''
    )
      .trim()
      .toLowerCase();

    if (!expectedAudience) {
      return res.status(503).json({
        success: false,
        message: 'CLOUD_SCHEDULER_AUDIENCE is not configured on Cloud Run backup service.',
      });
    }

    try {
      const verifier = config.verifyOidcToken || verifyGoogleOidcJwt;
      const claims = await verifier(token, expectedAudience);
      if (claims.email_verified === false) {
        return res.status(403).json({
          success: false,
          message: 'OIDC caller email is not verified.',
        });
      }
      if (expectedSa && String(claims.email || '').toLowerCase() !== expectedSa) {
        return res.status(403).json({
          success: false,
          message: 'OIDC service account email is not authorized for backup scheduling.',
        });
      }
      (req as Request & { oidcCaller?: OidcClaims }).oidcCaller = claims;
      return next();
    } catch (err) {
      return res.status(401).json({
        success: false,
        message: `Invalid Cloud Scheduler OIDC token: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };
}

export function createServiceSecretAuthMiddleware(expectedSecret?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const configured = (expectedSecret ?? process.env.BACKUP_SERVICE_AUTH_TOKEN ?? '').trim();
    if (!configured) {
      return res.status(503).json({
        success: false,
        message: 'BACKUP_SERVICE_AUTH_TOKEN is not configured.',
      });
    }
    const headerToken = String(req.headers['x-backup-service-token'] || '').trim();
    const authBearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const candidate = headerToken || authBearer;
    if (!timingSafeTokenEqual(configured, candidate)) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized backup service-to-service credential.',
      });
    }
    return next();
  };
}
