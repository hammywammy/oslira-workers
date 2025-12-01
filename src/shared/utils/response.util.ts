import type { Context } from 'hono';

export interface SuccessResponse<T> {
  success: true;
  data: T;
  meta?: {
    timestamp: string;
    requestId?: string;
    [key: string]: unknown;
  };
}

export interface ErrorResponse {
  success: false;
  error: string;
  code: string;
  details?: Record<string, unknown>;
  meta?: {
    timestamp: string;
    requestId?: string;
  };
}

/** Standard success response */
export function successResponse<T>(
  c: Context,
  data: T,
  meta?: Record<string, unknown>
): Response {
  const response: SuccessResponse<T> = {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  };

  return c.json(response, 200);
}

/** Created response (201) */
export function createdResponse<T>(
  c: Context,
  data: T,
  meta?: Record<string, unknown>
): Response {
  const response: SuccessResponse<T> = {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      ...meta
    }
  };

  return c.json(response, 201);
}

/** No content response (204) */
export function noContentResponse(c: Context): Response {
  return c.body(null, 204);
}

/** Error response */
export function errorResponse(
  c: Context,
  message: string,
  code: string = 'ERROR',
  statusCode: number = 400,
  details?: Record<string, unknown>
): Response {
  const response: ErrorResponse = {
    success: false,
    error: message,
    code,
    details,
    meta: {
      timestamp: new Date().toISOString()
    }
  };

  return c.json(response, statusCode);
}

/** Paginated response */
export function paginatedResponse<T>(
  c: Context,
  data: T[],
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  }
): Response {
  return successResponse(c, data, {
    pagination: {
      total: pagination.total,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalPages: Math.ceil(pagination.total / pagination.pageSize),
      hasMore: pagination.hasMore
    }
  });
}
