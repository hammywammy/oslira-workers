// infrastructure/queues/business-context.consumer.ts

import type { Env } from '@/shared/types/env.types';
import type { MessageBatch, Message } from '@cloudflare/workers-types';
import type { BusinessContextQueueMessage } from '@/shared/types/business-context.types';

/**
 * BUSINESS CONTEXT QUEUE CONSUMER
 * 
 * Processes business context generation requests from queue
 * 
 * Flow:
 * 1. User submits onboarding form → Message added to queue
 * 2. Consumer picks up message → Triggers workflow
 * 3. Workflow executes → Generates context + saves to DB
 * 4. On failure → Retry (3 attempts) then DLQ
 */

/**
 * Queue consumer handler
 */
export async function handleBusinessContextQueue(
  batch: MessageBatch<BusinessContextQueueMessage>,
  env: Env
): Promise<void> {
  console.log(`[BusinessContextQueue] Processing batch of ${batch.messages.length} messages`);

  for (const message of batch.messages) {
    try {
      await processBusinessContextMessage(message, env);
      message.ack(); // Success - remove from queue
    } catch (error: any) {
      console.error(`[BusinessContextQueue] Error processing message:`, error);

      // Retry logic
      if (message.attempts < 3) {
        const delay = Math.pow(2, message.attempts) * 10; // Exponential backoff: 10s, 20s, 40s
        console.log(`[BusinessContextQueue] Retrying in ${delay}s... (attempt ${message.attempts + 1}/3)`);
        message.retry({ delaySeconds: delay });
      } else {
        console.error(`[BusinessContextQueue] Max retries exceeded for run ${message.body.run_id}`);
        await markGenerationFailed(message.body, error.message, env);
        message.ack(); // Remove from queue after max retries
      }
    }
  }
}

/**
 * Process individual business context message
 */
async function processBusinessContextMessage(
  message: Message<BusinessContextQueueMessage>,
  env: Env
): Promise<void> {
  const data = message.body;

  console.log(`[BusinessContextQueue] Processing: run_id=${data.run_id}, account=${data.account_id}`);

  // Trigger workflow
  const workflow = await env.BUSINESS_CONTEXT_WORKFLOW.create({
    params: {
      run_id: data.run_id,
      account_id: data.account_id,
      user_inputs: data.user_inputs,
      requested_at: data.requested_at
    }
  });

  console.log(`[BusinessContextQueue] Workflow triggered: ${data.run_id}`);
}

/**
 * Mark generation as failed in Durable Object
 */
async function markGenerationFailed(
  data: BusinessContextQueueMessage,
  errorMessage: string,
  env: Env
): Promise<void> {
  try {
    const progressId = env.BUSINESS_CONTEXT_PROGRESS.idFromName(data.run_id);
    const progressDO = env.BUSINESS_CONTEXT_PROGRESS.get(progressId);

    await progressDO.fetch('http://do/fail', {
      method: 'POST',
      body: JSON.stringify({ message: errorMessage })
    });

    console.log(`[BusinessContextQueue] Marked generation ${data.run_id} as failed`);
  } catch (error) {
    console.error(`[BusinessContextQueue] Failed to mark as failed:`, error);
  }
}
