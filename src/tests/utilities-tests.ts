// src/tests/utilities-tests.ts
import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { successResponse, createdResponse, paginatedResponse, errorResponse } from '@/shared/utils/response.util';
import { validateBody, CommonSchemas } from '@/shared/utils/validation.util';
import { logger } from '@/shared/utils/logger.util';
import { generateRunId, generateLeadId, generateRequestId } from '@/shared/utils/id.util';
import { z } from 'zod';

export function registerUtilitiesTests(app: Hono<{ Bindings: Env }>) {

  // Response: Success
  app.get('/test/utils/response-success', (c) => {
    return successResponse(c, {
      message: 'Test success response',
      timestamp: new Date().toISOString()
    });
  });

  // Response: Created
  app.post('/test/utils/response-created', (c) => {
    return createdResponse(c, {
      id: 'test_123',
      message: 'Resource created'
    });
  });

  // Response: Paginated
  app.get('/test/utils/response-paginated', (c) => {
    const mockData = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `Item ${i + 1}` }));
    return paginatedResponse(c, mockData, {
      total: 100,
      page: 1,
      pageSize: 5,
      hasMore: true
    });
  });

  // Response: Error
  app.get('/test/utils/response-error', (c) => {
    return errorResponse(c, 'Test error message', 'TEST_ERROR', 400);
  });

  // Validation: Valid Body
  app.post('/test/utils/validation-success', async (c) => {
    try {
      const schema = z.object({
        username: CommonSchemas.instagramUsername,
        analysisType: CommonSchemas.analysisType
      });
      
      const body = await c.req.json();
      const validated = validateBody(schema, body);
      
      return successResponse(c, {
        message: 'Validation passed',
        validated
      });
    } catch (error: any) {
      return errorResponse(c, error.message, 'VALIDATION_ERROR', 400);
    }
  });

  // Validation: Invalid Body
  app.post('/test/utils/validation-fail', async (c) => {
    try {
      const schema = z.object({
        username: CommonSchemas.instagramUsername,
        analysisType: CommonSchemas.analysisType
      });
      
      const body = { username: '', analysisType: 'invalid' };
      validateBody(schema, body);
      
      return successResponse(c, { message: 'Should not reach here' });
    } catch (error: any) {
      return successResponse(c, {
        message: 'Validation correctly failed',
        error: error.errors
      });
    }
  });

  // Logger
  app.get('/test/utils/logger', (c) => {
    logger.debug('Debug message', { test: true });
    logger.info('Info message', { test: true });
    logger.warn('Warning message', { test: true });
    logger.error('Error message', { test: true });
    
    return successResponse(c, {
      message: 'Check console for structured logs',
      note: 'Logs are JSON format in production'
    });
  });

  // ID Generators
  app.get('/test/utils/id-generators', (c) => {
    return successResponse(c, {
      run_id: generateRunId(),
      lead_id: generateLeadId(),
      request_id: generateRequestId(),
      note: 'All IDs are unique and URL-safe'
    });
  });
}
