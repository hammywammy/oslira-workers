// infrastructure/durable-objects/business-context-progress.do.ts

import { DurableObject } from 'cloudflare:workers';
import type { BusinessContextProgressState } from '@/shared/types/business-context.types';
import type { Env } from '@/shared/types/env.types';

/**
 * BUSINESS CONTEXT PROGRESS DURABLE OBJECT
 * 
 * Tracks real-time progress for business context generation
 * 
 * Features:
 * - Real-time progress updates (0-100%)
 * - Simple 3-step process tracking
 * - Automatic cleanup after 24 hours
 * 
 * Usage:
 * - Workflow updates progress as it executes
 * - Frontend polls GET /api/business/generate-context/:runId/progress
 */

export class BusinessContextProgressDO extends DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  }

  /**
   * Handle HTTP requests to this Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    try {
      // GET /progress - Get current progress
      if (method === 'GET' && url.pathname === '/progress') {
        const progress = await this.getProgress();
        return Response.json(progress);
      }

      // POST /initialize - Initialize progress state
      if (method === 'POST' && url.pathname === '/initialize') {
        const params = await request.json();
        await this.initialize(params);
        return Response.json({ success: true });
      }

      // POST /update - Update progress
      if (method === 'POST' && url.pathname === '/update') {
        const update = await request.json();
        await this.updateProgress(update);
        return Response.json({ success: true });
      }

      // POST /complete - Mark as complete
      if (method === 'POST' && url.pathname === '/complete') {
        const result = await request.json();
        await this.completeGeneration(result);
        return Response.json({ success: true });
      }

      // POST /fail - Mark as failed
      if (method === 'POST' && url.pathname === '/fail') {
        const error = await request.json();
        await this.failGeneration(error.message);
        return Response.json({ success: true });
      }

      return Response.json({ error: 'Not found' }, { status: 404 });

    } catch (error: any) {
      console.error('[BusinessContextProgressDO] Error:', error);
      return Response.json({ error: error.message }, { status: 500 });
    }
  }

  /**
   * Initialize progress state
   */
  async initialize(params: {
    run_id: string;
    account_id: string;
  }): Promise<void> {
    const initialState: BusinessContextProgressState = {
      run_id: params.run_id,
      account_id: params.account_id,
      status: 'pending',
      progress: 0,
      current_step: 'Initializing business context generation',
      total_steps: 3,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await this.state.storage.put('progress', initialState);
    
    // Set automatic cleanup alarm (24 hours)
    await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
  }

  /**
   * Get current progress
   */
  async getProgress(): Promise<BusinessContextProgressState | null> {
    return await this.state.storage.get<BusinessContextProgressState>('progress');
  }

  /**
   * Update progress
   */
  async updateProgress(update: {
    progress: number;
    current_step: string;
    status?: 'pending' | 'processing' | 'complete' | 'failed';
  }): Promise<void> {
    const current = await this.getProgress();
    
    if (!current) {
      throw new Error('Progress not initialized');
    }

    const updated: BusinessContextProgressState = {
      ...current,
      progress: update.progress,
      current_step: update.current_step,
      status: update.status || 'processing',
      updated_at: new Date().toISOString()
    };

    await this.state.storage.put('progress', updated);
  }

  /**
   * Mark generation as complete
   */
  async completeGeneration(result: any): Promise<void> {
    const current = await this.getProgress();
    
    if (!current) {
      throw new Error('Progress not initialized');
    }

    const completed: BusinessContextProgressState = {
      ...current,
      status: 'complete',
      progress: 100,
      current_step: 'Business context generated successfully',
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      result: result
    };

    await this.state.storage.put('progress', completed);
  }

  /**
   * Mark generation as failed
   */
  async failGeneration(errorMessage: string): Promise<void> {
    const current = await this.getProgress();
    
    if (!current) {
      throw new Error('Progress not initialized');
    }

    const failed: BusinessContextProgressState = {
      ...current,
      status: 'failed',
      current_step: 'Generation failed',
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      error_message: errorMessage
    };

    await this.state.storage.put('progress', failed);
  }

  /**
   * Alarm handler - cleanup after 24 hours
   */
  async alarm(): Promise<void> {
    console.log('[BusinessContextProgressDO] Cleaning up old progress state');
    await this.state.storage.deleteAll();
  }
}
