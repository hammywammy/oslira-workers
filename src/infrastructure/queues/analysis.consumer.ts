// infrastructure/queues/analysis.consumer.ts

import type { Env } from '@/shared/types/env.types';
import type { MessageBatch, Message } from '@cloudflare/workers-types';
import { AnalyzeLeadUseCase } from '@/features/analysis/application/analyze-lead.usecase';

/**
 * ANALYSIS QUEUE CONSUMER
 * 
 * Processes analysis requests from queue
 * Queue enables:
 * - Async execution (no Worker timeout limits)
 * - Automatic retry on failure
 * - Rate limiting / throttling
 * - Priority queuing (future)
 * 
 * Flow:
 * 1. User requests analysis → Message added to queue
 * 2. Consumer picks up message → Executes analysis
 * 3. Analysis complete → Update database + notify user
 * 4. On failure → Retry (3 attempts) then DLQ
 */

export interface AnalysisQueueMessage {
  run_id: string;
  account_id: string;
  business_profile_id: string;
  username: string;
  analysis_type: 'light' | 'deep' | 'xray';
  requested_at: string;
  priority?: 'high' | 'normal' | 'low'; // Future: Priority queuing
}

/**
 * Queue consumer handler
 */
export async function handleAnalysisQueue(
  batch: MessageBatch<AnalysisQueueMessage>,
  env: Env
): Promise<void> {
  console.log(`[AnalysisQueue] Processing batch of ${batch.messages.length} messages`);

  for (const message of batch.messages) {
    try {
      await processAnalysisMessage(message, env);
      message.ack(); // Success - remove from queue
    } catch (error: any) {
      console.error(`[AnalysisQueue] Error processing message:`, error);
      
      // Retry logic
      if (message.attempts < 3) {
        message.retry({ delaySeconds: Math.pow(2, message.attempts) * 10 }); // Exponential backoff
      } else {
        console.error(`[AnalysisQueue] Max retries exceeded for run ${message.body.run_id}`);
        await markAnalysisFailed(message.body, error.message, env);
        message.ack(); // Remove from queue
      }
    }
  }
}

/**
 * Process individual analysis message
 */
async function processAnalysisMessage(
  message: Message<AnalysisQueueMessage>,
  env: Env
): Promise<void> {
  const data = message.body;

  console.log(`[AnalysisQueue] Processing: ${data.analysis_type} analysis for @${data.username} (${data.run_id})`);

  // Execute analysis via use case
  const useCase = new AnalyzeLeadUseCase(env);
  
  const result = await useCase.execute({
    accountId: data.account_id,
    businessProfileId: data.business_profile_id,
    username: data.username,
    analysisType: data.analysis_type
  });

  console.log(`[AnalysisQueue] Completed: ${data.run_id} - Score: ${result.overall_score}/100`);

  // TODO: Notify user via WebSocket / Server-Sent Events
  // await notifyUser(data.account_id, result);
}

/**
 * Mark analysis as failed in database
 */
async function markAnalysisFailed(
  data: AnalysisQueueMessage,
  errorMessage: string,
  env: Env
): Promise<void> {
  try {
    const { SupabaseClientFactory } = await import('@/infrastructure/database/supabase.client');
    const { AnalysisRepository } = await import('@/infrastructure/database/repositories/analysis.repository');
    
    const supabase = await SupabaseClientFactory.createAdminClient(env);
    const analysisRepo = new AnalysisRepository(supabase);

    await analysisRepo.updateAnalysis(data.run_id, {
      status: 'failed',
      error_message: errorMessage,
      completed_at: new Date().toISOString()
    });

    console.log(`[AnalysisQueue] Marked analysis ${data.run_id} as failed`);
  } catch (error) {
    console.error(`[AnalysisQueue] Failed to mark analysis as failed:`, error);
  }
}
