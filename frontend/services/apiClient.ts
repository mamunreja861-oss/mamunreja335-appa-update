import { ApiResponseEnvelope, PaginationMeta } from '../modules/types';
import { securityRequest } from './securityApi';

export const API_CONFIG = {
  baseUrl: import.meta.env.VITE_API_BASE_URL || '/api',
  timeoutMs: Number(import.meta.env.VITE_API_TIMEOUT_MS || 15000),
  mode: 'LIVE_API' as const,
};

export interface PaginatedResult<T> {
  items: T[];
  pagination: PaginationMeta;
}

export function paginateArray<T>(items: T[], page: number, perPage: number): PaginatedResult<T> {
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * perPage;
  return {
    items: items.slice(startIndex, startIndex + perPage),
    pagination: {
      page: safePage,
      perPage,
      totalItems,
      totalPages,
    },
  };
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0);
}

/**
 * Live REST API client for MUN COMPUTER ERP endpoints.
 */
export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponseEnvelope<T>> {
  const normalizedPath = endpoint.startsWith('/api')
    ? endpoint
    : `/api${endpoint.startsWith('/') ? '' : '/'}${endpoint}`;
  return securityRequest<T>(normalizedPath, {
    ...options,
    timeoutMs: API_CONFIG.timeoutMs,
  });
}
