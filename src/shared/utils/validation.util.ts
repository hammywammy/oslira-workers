// src/shared/utils/validation.util.ts
import { z } from 'zod';

/**
 * Common validation schemas
 */
export const CommonSchemas = {
  // UUID validation
  uuid: z.string().uuid('Invalid UUID format'),
  
  // Instagram username
  instagramUsername: z.string()
    .min(1, 'Username required')
    .max(30, 'Username too long')
    .regex(/^[a-zA-Z0-9._]+$/, 'Invalid Instagram username format'),
  
  // Analysis type (extensible framework - currently only 'light' is supported)
  analysisType: z.enum(['light'], {
    errorMap: () => ({ message: 'Analysis type must be light' })
  }),
  
  // Pagination
  pagination: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50)
  }),
  
  // Credit amount
  creditAmount: z.number().int().min(1, 'Credit amount must be at least 1'),
  
  // Account ID
  accountId: z.string().uuid('Invalid account ID')
};

/**
 * Validate request body against schema
 */
export function validateBody<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): T {
  return schema.parse(data);
}

/**
 * Validate query parameters
 */
export function validateQuery<T>(
  schema: z.ZodSchema<T>,
  params: Record<string, string | string[] | undefined>
): T {
  return schema.parse(params);
}

/**
 * Safe validation (returns error instead of throwing)
 */
export function safeValidate<T>(
  schema: z.ZodSchema<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: z.ZodError } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return { success: false, error: result.error };
}

/**
 * Format Zod errors for API response
 */
export function formatZodError(error: z.ZodError): {
  message: string;
  fields: Record<string, string[]>;
} {
  const fields: Record<string, string[]> = {};
  
  error.errors.forEach(err => {
    const path = err.path.join('.');
    if (!fields[path]) {
      fields[path] = [];
    }
    fields[path].push(err.message);
  });
  
  return {
    message: 'Validation failed',
    fields
  };
}
