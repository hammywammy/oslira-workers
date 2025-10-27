// infrastructure/durable-objects/business-context-progress.do.ts - WITH COMPREHENSIVE LOGGING

import { DurableObject } from 'cloudflare:workers';
import type { BusinessContextProgressState } from '@/shared/types/business-context.types';
import type { Env } from '@/shared/types/env.types';

/**
 * BUSINESS CONTEXT PROGRESS DURABLE OBJECT - WITH LOGGING
 * 
 * Logs every operation for debugging
 */

export class BusinessContextProgressDO extends DurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    console.log('[BusinessContextProgressDO] Constructor called');
    console.log('[BusinessContextProgressDO] DO ID:', state.id);
  }

  /**
   * Handle HTTP requests to this Durable Object
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    console.log('='.repeat(80));
    console.log('[BusinessContextProgressDO] REQUEST RECEIVED');
    console.log('[BusinessContextProgressDO] Method:', method);
    console.log('[BusinessContextProgressDO] Path:', url.pathname);
    console.log('[BusinessContextProgressDO] DO ID:', this.state.id);
    console.log('='.repeat(80));

    try {
      // GET /progress - Get current progress
      if (method === 'GET' && url.pathname === '/progress') {
        console.log('[BusinessContextProgressDO] Handling GET /progress');
        
        const progress = await this.getProgress();
        
        console.log('[BusinessContextProgressDO] Progress retrieved:', JSON.stringify(progress, null, 2));
        console.log('[BusinessContextProgressDO] Returning progress');
        
        return Response.json(progress);
      }

      // POST /initialize - Initialize progress state
      if (method === 'POST' && url.pathname === '/initialize') {
        console.log('[BusinessContextProgressDO] Handling POST /initialize');
        
        const params = await request.json();
        console.log('[BusinessContextProgressDO] Initialize params:', JSON.stringify(params, null, 2));
        
        await this.initialize(params);
        
        console.log('[BusinessContextProgressDO] Initialize complete');
        return Response.json({ success: true });
      }

      // POST /update - Update progress
      if (method === 'POST' && url.pathname === '/update') {
        console.log('[BusinessContextProgressDO] Handling POST /update');
        
        const update = await request.json();
        console.log('[BusinessContextProgressDO] Update data:', JSON.stringify(update, null, 2));
        
        await this.updateProgress(update);
        
        console.log('[BusinessContextProgressDO] Update complete');
        return Response.json({ success: true });
      }

      // POST /complete - Mark as complete
      if (method === 'POST' && url.pathname === '/complete') {
        console.log('[BusinessContextProgressDO] Handling POST /complete');
        
        const result = await request.json();
        console.log('[BusinessContextProgressDO] Complete data keys:', Object.keys(result));
        
        await this.completeGeneration(result);
        
        console.log('[BusinessContextProgressDO] Complete operation finished');
        return Response.json({ success: true });
      }

      // POST /fail - Mark as failed
      if (method === 'POST' && url.pathname === '/fail') {
        console.log('[BusinessContextProgressDO] Handling POST /fail');
        
        const error = await request.json();
        console.log('[BusinessContextProgressDO] Failure message:', error.message);
        
        await this.failGeneration(error.message);
        
        console.log('[BusinessContextProgressDO] Fail operation finished');
        return Response.json({ success: true });
      }

      console.log('[BusinessContextProgressDO] No matching route found');
      return Response.json({ error: 'Not found' }, { status: 404 });

    } catch (error: any) {
      console.error('[BusinessContextProgressDO] REQUEST FAILED');
      console.error('[BusinessContextProgressDO] Error name:', error.name);
      console.error('[BusinessContextProgressDO] Error message:', error.message);
      console.error('[BusinessContextProgressDO] Error stack:', error.stack);
      
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
    console.log('[BusinessContextProgressDO] Initializing state');
    console.log('[BusinessContextProgressDO] Run ID:', params.run_id);
    console.log('[BusinessContextProgressDO] Account ID:', params.account_id);

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

    console.log('[BusinessContextProgressDO] Initial state:', JSON.stringify(initialState, null, 2));
    console.log('[BusinessContextProgressDO] Storing state in DO storage');

    try {
      await this.state.storage.put('progress', initialState);
      console.log('[BusinessContextProgressDO] State stored successfully');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] FAILED to store state');
      console.error('[BusinessContextProgressDO] Error:', error.message);
      throw error;
    }
    
    // Set automatic cleanup alarm (24 hours)
    console.log('[BusinessContextProgressDO] Setting cleanup alarm (24 hours)');
    try {
      await this.state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
      console.log('[BusinessContextProgressDO] Alarm set successfully');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] FAILED to set alarm');
      console.error('[BusinessContextProgressDO] Error:', error.message);
      // Don't throw - alarm is nice-to-have, not critical
    }
  }

  /**
   * Get current progress
   */
  async getProgress(): Promise<BusinessContextProgressState | null> {
    console.log('[BusinessContextProgressDO] Getting progress from storage');
    
    try {
      const progress = await this.state.storage.get<BusinessContextProgressState>('progress');
      
      if (progress) {
        console.log('[BusinessContextProgressDO] Progress found');
        console.log('[BusinessContextProgressDO] Status:', progress.status);
        console.log('[BusinessContextProgressDO] Progress:', progress.progress);
        console.log('[BusinessContextProgressDO] Step:', progress.current_step);
      } else {
        console.log('[BusinessContextProgressDO] No progress found in storage');
      }
      
      return progress;
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] FAILED to get progress');
      console.error('[BusinessContextProgressDO] Error:', error.message);
      throw error;
    }
  }

  /**
   * Update progress
   */
  async updateProgress(update: {
    progress: number;
    current_step: string;
    status?: 'pending' | 'processing' | 'complete' | 'failed';
  }): Promise<void> {
    console.log('[BusinessContextProgressDO] Updating progress');
    console.log('[BusinessContextProgressDO] New progress:', update.progress);
    console.log('[BusinessContextProgressDO] New step:', update.current_step);
    console.log('[BusinessContextProgressDO] New status:', update.status);

    const current = await this.getProgress();
    
    if (!current) {
      console.error('[BusinessContextProgressDO] Cannot update: progress not initialized');
      throw new Error('Progress not initialized');
    }

    console.log('[BusinessContextProgressDO] Current state before update:', JSON.stringify(current, null, 2));

    const updated: BusinessContextProgressState = {
      ...current,
      progress: update.progress,
      current_step: update.current_step,
      status: update.status || 'processing',
      updated_at: new Date().toISOString()
    };

    console.log('[BusinessContextProgressDO] Updated state:', JSON.stringify(updated, null, 2));
    console.log('[BusinessContextProgressDO] Storing updated state');

    try {
      await this.state.storage.put('progress', updated);
      console.log('[BusinessContextProgressDO] State updated successfully');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] FAILED to update state');
      console.error('[BusinessContextProgressDO] Error:', error.message);
      throw error;
    }
  }

  /**
   * Mark generation as complete
   */
  async completeGeneration(result: any): Promise<void> {
    console.log('[BusinessContextProgressDO] Completing generation');
    console.log('[BusinessContextProgressDO] Result keys:', Object.keys(result));

    const current = await this.getProgress();
    
    if (!current) {
      console.error('[BusinessContextProgressDO] Cannot complete: progress not initialized');
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

    console.log('[BusinessContextProgressDO] Completed state:', JSON.stringify(completed, null, 2));
    console.log('[BusinessContextProgressDO] Storing completed state');

    try {
      await this.state.storage.put('progress', completed);
      console.log('[BusinessContextProgressDO] Completion stored successfully');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] FAILED to store completion');
      console.error('[BusinessContextProgressDO] Error:', error.message);
      throw error;
    }
  }

  /**
   * Mark generation as failed
   */
  async failGeneration(errorMessage: string): Promise<void> {
    console.log('[BusinessContextProgressDO] Marking as failed');
    console.log('[BusinessContextProgressDO] Error message:', errorMessage);

    const current = await this.getProgress();
    
    if (!current) {
      console.error('[BusinessContextProgressDO] Cannot fail: progress not initialized');
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

    console.log('[BusinessContextProgressDO] Failed state:', JSON.stringify(failed, null, 2));
    console.log('[BusinessContextProgressDO] Storing failed state');

    try {
      await this.state.storage.put('progress', failed);
      console.log('[BusinessContextProgressDO] Failure stored successfully');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] FAILED to store failure');
      console.error('[BusinessContextProgressDO] Error:', error.message);
      throw error;
    }
  }

  /**
   * Alarm handler - cleanup after 24 hours
   */
  async alarm(): Promise<void> {
    console.log('[BusinessContextProgressDO] ALARM TRIGGERED - Cleanup starting');
    console.log('[BusinessContextProgressDO] DO ID:', this.state.id);
    
    try {
      await this.state.storage.deleteAll();
      console.log('[BusinessContextProgressDO] Cleanup complete - all data deleted');
    } catch (error: any) {
      console.error('[BusinessContextProgressDO] Cleanup FAILED');
      console.error('[BusinessContextProgressDO] Error:', error.message);
    }
  }
}
