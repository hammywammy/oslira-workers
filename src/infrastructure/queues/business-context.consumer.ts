// infrastructure/queues/business-context.consumer.ts

import type { Env } from '@/shared/types/env.types';
import type { MessageBatch, Message } from '@cloudflare/workers-types';
import type { BusinessContextQueueMessage } from '@/shared/types/business-context.types';
import { logger } from '@/shared/utils/logger.util';

/**
 * BUSINESS CONTEXT QUEUE CONSUMER - WITH LOGGING
 * 
 * Logs every step of queue processing and workflow triggering
 */

export async function handleBusinessContextQueue(
  batch: MessageBatch<BusinessContextQueueMessage>,
  env: Env
): Promise<void> {
  // Batch boundary
  logger.info('Batch processing started');
  logger.info('Processing business context batch', { batchSize: batch.messages.length });
  logger.info('Queue info', { queueName: batch.queue });
  // Batch boundary

  for (const message of batch.messages) {
    // Message boundary
    logger.info('Message processing started');
    logger.info('Processing message', { messageId: message.id });
    logger.info('Message attempt info', { attempt: message.attempts });
    logger.info('Message timestamp', { timestamp: message.timestamp });
    logger.info('Message body', message.body);
    // Message boundary

    try {
      await processBusinessContextMessage(message, env);
      
      logger.info('Message processed successfully');
      logger.info('Acknowledging message', { messageId: message.id });
      message.ack();
      logger.info('Message acknowledged');
      
    } catch (error: any) {
      logger.error('Message processing failed');
      logger.error('Error details', { errorName: error.name);
      logger.error('Error message', { errorMessage: error.message);
      logger.error('Error stack', { errorStack: error.stack);

      // Retry logic
      if (message.attempts < 3) {
        const delay = Math.pow(2, message.attempts) * 10;
        logger.info('Retrying message', { messageId: message.id });
        logger.info('Retry delay', { delaySeconds: delay });
        logger.info('Retry attempt', { attempt: message.attempts + 1, maxAttempts: 3 });
        
        message.retry({ delaySeconds: delay });
        logger.info('Retry scheduled');
      } else {
        logger.error('Max retries exceeded', { messageId: message.id });
        logger.error('Failed message run ID', { runId: message.body.run_id });
        
        await markGenerationFailed(message.body, error.message, env);
        
        logger.info('Acknowledging failed message', { messageId: message.id });
        message.ack();
        logger.info('Failed message acknowledged');
      }
    }

    // Message boundary
  }

  // Batch boundary
  logger.info('Batch processing complete');
  // Batch boundary
}

/**
 * Process individual business context message
 */
async function processBusinessContextMessage(
  message: Message<BusinessContextQueueMessage>,
  env: Env
): Promise<void> {
  const data = message.body;

  logger.info('Processing business context message', { runId: data.run_id });
  logger.info('Account info', { accountId: data.account_id });
  logger.info('Request timestamp', { requestedAt: data.requested_at });

  // Check if workflow binding exists
  if (!env.BUSINESS_CONTEXT_WORKFLOW) {
    logger.error('CRITICAL: BUSINESS_CONTEXT_WORKFLOW binding is undefined');
    logger.error('Available env bindings', { bindings: Object.keys(env));
    throw new Error('BUSINESS_CONTEXT_WORKFLOW binding not found');
  }

  logger.info('BUSINESS_CONTEXT_WORKFLOW binding exists');
  logger.info('Workflow binding type', { type: typeof env.BUSINESS_CONTEXT_WORKFLOW);

  // Trigger workflow
  logger.info('Creating workflow instance');
  logger.info('Workflow params', JSON.stringify({
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

    logger.info('Workflow instance created');
    logger.info('Workflow object', { workflow });
    logger.info('Workflow ID', { workflowId: data.run_id });
    logger.info('Workflow triggered successfully');
    
  } catch (error: any) {
    logger.error('Failed to create workflow');
    logger.error('Error details', { errorName: error.name);
    logger.error('Error message', { errorMessage: error.message);
    logger.error('Error stack', { errorStack: error.stack);
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
  logger.info('Marking generation as failed', { runId: data.run_id });
  logger.info('Failure error message', { errorMessage });

  try {
    if (!env.BUSINESS_CONTEXT_PROGRESS) {
      logger.error('CRITICAL: BUSINESS_CONTEXT_PROGRESS binding is undefined');
      return;
    }

    const progressId = env.BUSINESS_CONTEXT_PROGRESS.idFromName(data.run_id);
    logger.info('Progress DO ID', { progressId: progressId);
    
    const progressDO = env.BUSINESS_CONTEXT_PROGRESS.get(progressId);
    logger.info('Progress DO stub created');

    const response = await progressDO.fetch('http://do/fail', {
      method: 'POST',
      body: JSON.stringify({ message: errorMessage })
    });

    logger.info('DO fail response status', { status: response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      logger.error('DO fail request failed', { error: errorText);
    } else {
      logger.info('Successfully marked as failed', { runId: data.run_id });
    }
  } catch (error: any) {
    logger.error('Failed to mark as failed in DO');
    logger.error('Error details', { errorName: error.name);
    logger.error('Error message', { errorMessage: error.message);
    logger.error('Error stack', { errorStack: error.stack);
  }
}
