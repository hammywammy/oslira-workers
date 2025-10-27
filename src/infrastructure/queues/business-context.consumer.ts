// infrastructure/queues/business-context.consumer.ts - WITH COMPREHENSIVE LOGGING

import type { Env } from '@/shared/types/env.types';
import type { MessageBatch, Message } from '@cloudflare/workers-types';
import type { BusinessContextQueueMessage } from '@/shared/types/business-context.types';

/**
 * BUSINESS CONTEXT QUEUE CONSUMER - WITH LOGGING
 * 
 * Logs every step of queue processing and workflow triggering
 */

export async function handleBusinessContextQueue(
  batch: MessageBatch<BusinessContextQueueMessage>,
  env: Env
): Promise<void> {
  console.log('='.repeat(80));
  console.log(`[BusinessContextQueue] BATCH PROCESSING STARTED`);
  console.log(`[BusinessContextQueue] Batch size: ${batch.messages.length}`);
  console.log(`[BusinessContextQueue] Queue name: ${batch.queue}`);
  console.log('='.repeat(80));

  for (const message of batch.messages) {
    console.log('-'.repeat(80));
    console.log(`[BusinessContextQueue] MESSAGE PROCESSING STARTED`);
    console.log(`[BusinessContextQueue] Message ID: ${message.id}`);
    console.log(`[BusinessContextQueue] Attempt: ${message.attempts}`);
    console.log(`[BusinessContextQueue] Timestamp: ${message.timestamp}`);
    console.log(`[BusinessContextQueue] Body:`, JSON.stringify(message.body, null, 2));
    console.log('-'.repeat(80));

    try {
      await processBusinessContextMessage(message, env);
      
      console.log(`[BusinessContextQueue] MESSAGE PROCESSED SUCCESSFULLY`);
      console.log(`[BusinessContextQueue] Acknowledging message ${message.id}`);
      message.ack();
      console.log(`[BusinessContextQueue] Message acknowledged`);
      
    } catch (error: any) {
      console.error('[BusinessContextQueue] MESSAGE PROCESSING FAILED');
      console.error('[BusinessContextQueue] Error name:', error.name);
      console.error('[BusinessContextQueue] Error message:', error.message);
      console.error('[BusinessContextQueue] Error stack:', error.stack);

      // Retry logic
      if (message.attempts < 3) {
        const delay = Math.pow(2, message.attempts) * 10;
        console.log(`[BusinessContextQueue] RETRYING message ${message.id}`);
        console.log(`[BusinessContextQueue] Retry delay: ${delay}s`);
        console.log(`[BusinessContextQueue] Attempt: ${message.attempts + 1}/3`);
        
        message.retry({ delaySeconds: delay });
        console.log(`[BusinessContextQueue] Retry scheduled`);
      } else {
        console.error(`[BusinessContextQueue] MAX RETRIES EXCEEDED for message ${message.id}`);
        console.error(`[BusinessContextQueue] Run ID: ${message.body.run_id}`);
        
        await markGenerationFailed(message.body, error.message, env);
        
        console.log(`[BusinessContextQueue] Acknowledging failed message ${message.id}`);
        message.ack();
        console.log(`[BusinessContextQueue] Failed message acknowledged`);
      }
    }

    console.log('-'.repeat(80));
  }

  console.log('='.repeat(80));
  console.log(`[BusinessContextQueue] BATCH PROCESSING COMPLETE`);
  console.log('='.repeat(80));
}

/**
 * Process individual business context message
 */
async function processBusinessContextMessage(
  message: Message<BusinessContextQueueMessage>,
  env: Env
): Promise<void> {
  const data = message.body;

  console.log(`[BusinessContextQueue] Processing message for run_id: ${data.run_id}`);
  console.log(`[BusinessContextQueue] Account ID: ${data.account_id}`);
  console.log(`[BusinessContextQueue] Requested at: ${data.requested_at}`);

  // Check if workflow binding exists
  if (!env.BUSINESS_CONTEXT_WORKFLOW) {
    console.error('[BusinessContextQueue] CRITICAL: BUSINESS_CONTEXT_WORKFLOW binding is undefined!');
    console.error('[BusinessContextQueue] Available env bindings:', Object.keys(env));
    throw new Error('BUSINESS_CONTEXT_WORKFLOW binding not found');
  }

  console.log('[BusinessContextQueue] BUSINESS_CONTEXT_WORKFLOW binding exists: YES');
  console.log('[BusinessContextQueue] Workflow binding type:', typeof env.BUSINESS_CONTEXT_WORKFLOW);

  // Trigger workflow
  console.log('[BusinessContextQueue] Creating workflow instance...');
  console.log('[BusinessContextQueue] Workflow params:', JSON.stringify({
    run_id: data.run_id,
    account_id: data.account_id,
    user_inputs: data.user_inputs,
    requested_at: data.requested_at
  }, null, 2));

  try {
    const workflow = await env.BUSINESS_CONTEXT_WORKFLOW.create({
      id: data.run_id, // Use run_id as workflow ID for idempotency
      params: {
        run_id: data.run_id,
        account_id: data.account_id,
        user_inputs: data.user_inputs,
        requested_at: data.requested_at
      }
    });

    console.log('[BusinessContextQueue] Workflow instance created');
    console.log('[BusinessContextQueue] Workflow object:', workflow);
    console.log('[BusinessContextQueue] Workflow ID:', data.run_id);
    console.log('[BusinessContextQueue] Workflow triggered successfully');
    
  } catch (error: any) {
    console.error('[BusinessContextQueue] FAILED to create workflow');
    console.error('[BusinessContextQueue] Error name:', error.name);
    console.error('[BusinessContextQueue] Error message:', error.message);
    console.error('[BusinessContextQueue] Error stack:', error.stack);
    throw error;
  }
}

/**
 * Mark generation as failed in Durable Object
 */
async function markGenerationFailed(
  data: BusinessContextQueueMessage,
  errorMessage: string,
  env: Env
): Promise<void> {
  console.log(`[BusinessContextQueue] Marking generation as failed: ${data.run_id}`);
  console.log(`[BusinessContextQueue] Error message:`, errorMessage);

  try {
    if (!env.BUSINESS_CONTEXT_PROGRESS) {
      console.error('[BusinessContextQueue] CRITICAL: BUSINESS_CONTEXT_PROGRESS binding is undefined!');
      return;
    }

    const progressId = env.BUSINESS_CONTEXT_PROGRESS.idFromName(data.run_id);
    console.log('[BusinessContextQueue] Progress DO ID:', progressId);
    
    const progressDO = env.BUSINESS_CONTEXT_PROGRESS.get(progressId);
    console.log('[BusinessContextQueue] Progress DO stub created');

    const response = await progressDO.fetch('http://do/fail', {
      method: 'POST',
      body: JSON.stringify({ message: errorMessage })
    });

    console.log('[BusinessContextQueue] DO fail response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[BusinessContextQueue] DO fail request FAILED:', errorText);
    } else {
      console.log(`[BusinessContextQueue] Successfully marked ${data.run_id} as failed`);
    }
  } catch (error: any) {
    console.error('[BusinessContextQueue] FAILED to mark as failed in DO');
    console.error('[BusinessContextQueue] Error name:', error.name);
    console.error('[BusinessContextQueue] Error message:', error.message);
    console.error('[BusinessContextQueue] Error stack:', error.stack);
  }
}
