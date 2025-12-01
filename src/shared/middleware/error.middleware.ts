import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { logger } from '@/shared/utils/logger.util';

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR',
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }
}

interface ErrorClassification {
  statusCode: number;
  code: string;
  message: string;
  shouldLog: boolean;
}

/** Classify error by type */
function classifyError(error: unknown): ErrorClassification {
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      shouldLog: error.statusCode >= 500
    };
  }

  if (error instanceof Error) {
    // Supabase errors
    if ('code' in error && typeof (error as { code?: string }).code === 'string') {
      const errCode = (error as { code: string }).code;
      if (errCode.startsWith('PGRST')) {
        return {
          statusCode: 400,
          code: 'DATABASE_ERROR',
          message: 'Database operation failed',
          shouldLog: false
        };
      }
      if (errCode === 'ETIMEDOUT') {
        return {
          statusCode: 504,
          code: 'GATEWAY_TIMEOUT',
          message: 'Request timed out',
          shouldLog: true
        };
      }
    }

    // Validation errors
    if (error.name === 'ZodError') {
      return {
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        shouldLog: false
      };
    }

    // Timeout errors
    if (error.name === 'TimeoutError') {
      return {
        statusCode: 504,
        code: 'GATEWAY_TIMEOUT',
        message: 'Request timed out',
        shouldLog: true
      };
    }
  }

  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    shouldLog: true
  };
}

/**
 * Global error handler
 * Catches all unhandled errors and returns standardized response
 */
export function errorHandler(error: Error, c: Context<{ Bindings: Env }>): Response {
  const classified = classifyError(error);

  if (classified.shouldLog) {
    logger.error('Unhandled error', {
      error: error.message,
      stack: error.stack,
      path: c.req.path,
      method: c.req.method,
      code: classified.code
    });
  }

  const clientMessage = classified.statusCode >= 500
    ? 'An internal error occurred'
    : classified.message;

  return c.json({
    success: false,
    error: clientMessage,
    code: classified.code,
    timestamp: new Date().toISOString()
  }, classified.statusCode);
}

/**
 * Async error wrapper for route handlers
 * Catches async errors and passes to error handler
 */
export function asyncHandler(
  fn: (c: Context<{ Bindings: Env }>) => Promise<Response>
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    try {
      return await fn(c);
    } catch (error) {
      return errorHandler(error as Error, c);
    }
  };
}
