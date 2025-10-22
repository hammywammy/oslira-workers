// src/shared/utils/id.util.ts

/**
 * Generate unique IDs for various entities
 * Uses crypto.randomUUID() available in Cloudflare Workers
 */

/**
 * Generic ID generator with prefix
 * Used by handlers that need flexible ID generation
 */
export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

/**
 * Specific ID generators for type safety
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

export function generateBatchId(): string {
  return `batch_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
}

/**
 * Generate request ID for tracking
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${crypto.randomUUID().substring(0, 8)}`;
}

/**
 * Usage examples:
 * 
 * // Generic (flexible prefix):
 * const id = generateId('run');      // "run_a1b2c3d4e5f6g7h8"
 * const id = generateId('batch');    // "batch_a1b2c3d4e5f6g7h8"
 * 
 * // Type-specific (recommended for type safety):
 * const runId = generateRunId();     // "run_a1b2c3d4e5f6g7h8"
 * const leadId = generateLeadId();   // "lead_a1b2c3d4e5f6g7h8"
 */
