// src/shared/middleware/error.middleware.ts
import type { Context } from 'hono';
import type { Env } from '@/shared/types/env.types';

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code: string = 'INTERNAL_ERROR',
    public details?: any
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/**
 * Classify error by type
 */
function classifyError(error: any): {
  statusCode: number;
  code: string;
  message: string;
  shouldLog: boolean;
} {
  // Known AppError
  if (error instanceof AppError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
      shouldLog: error.statusCode >= 500
    };
  }
  
  // Supabase errors
  if (error.code?.startsWith('PGRST')) {
    return {
      statusCode: 400,
      code: 'DATABASE_ERROR',
      message: 'Database operation failed',
      shouldLog: false
    };
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
  
  // Network/timeout errors
  if (error.name === 'TimeoutError' || error.code === 'ETIMEDOUT') {
    return {
      statusCode: 504,
      code: 'GATEWAY_TIMEOUT',
      message: 'Request timed out',
      shouldLog: true
    };
  }
  
  // Default: Unknown server error
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
export function errorHandler(error: Error, c: Context<{ Bindings: Env }>) {
  const classified = classifyError(error);
  
  // Log errors (500+)
  if (classified.shouldLog) {
    console.error('Unhandled error:', {
      error: error.message,
      stack: error.stack,
      path: c.req.path,
      method: c.req.method,
      code: classified.code
    });
    
    // TODO: Send to Sentry in production
    // await Sentry.captureException(error);
  }
  
  // Never expose internal error details to client
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
) {
  return async (c: Context<{ Bindings: Env }>) => {
    try {
      return await fn(c);
    } catch (error) {
      return errorHandler(error as Error, c);
    }
  };
}
