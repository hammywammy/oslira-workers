// src/shared/utils/id.util.ts

/**
 * Generate unique IDs for various entities
 * Uses crypto.randomUUID() available in Cloudflare Workers
 */

export function generateRunId(): string {
  return `run_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

export function generateLeadId(): string {
  return `lead_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

export function generateAnalysisId(): string {
  return `analysis_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

export function generateTransactionId(): string {
  return `tx_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

/**
 * Generate request ID for tracking
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
}
