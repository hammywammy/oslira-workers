// infrastructure/cron/cron-jobs.handler.ts

import type { Env } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { getSentryService } from '@/infrastructure/monitoring/sentry.service';

/**
 * CRON JOBS HANDLER
 * 
 * Handles all scheduled tasks:
 * 1. Monthly credit renewal (subscriptions)
 * 2. Daily cleanup (old analyses, soft deleted records)
 * 3. Hourly failed analysis retry/cleanup
 */

export class CronJobsHandler {
  constructor(private env: Env) {}

  /**
   * Monthly credit renewal (1st of month, 3 AM UTC)
   * Grants subscription credits to all active subscribers
   */
  async monthlyRenewal(): Promise<void> {
    console.log('[Cron] Starting monthly credit renewal...');
    const sentry = await getSentryService(this.env);
    
    sentry.addBreadcrumb('Monthly renewal started', 'cron', 'info');

    try {
      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      
      // Get all active subscriptions
      const { data: subscriptions, error } = await supabase
        .from('subscriptions')
        .select('id, account_id, plan_type, stripe_subscription_id')
        .eq('status', 'active')
        .is('deleted_at', null);

      if (error) throw error;

      if (!subscriptions || subscriptions.length === 0) {
        console.log('[Cron] No active subscriptions found');
        return;
      }

      console.log(`[Cron] Processing ${subscriptions.length} active subscriptions`);

      const creditsRepo = new CreditsRepository(supabase);
      let successCount = 0;
      let failCount = 0;

      // Credit allocation by plan
      const planCredits: Record<string, number> = {
        starter: 50,
        pro: 200,
        enterprise: 1000
      };

      for (const sub of subscriptions) {
        try {
          const credits = planCredits[sub.plan_type] || 0;
          
          if (credits === 0) {
            console.warn(`[Cron] Unknown plan type: ${sub.plan_type}`);
            continue;
          }

          // Grant monthly credits
          await creditsRepo.addCredits(
            sub.account_id,
            credits,
            'subscription',
            `Monthly ${sub.plan_type} subscription renewal`
          );

          successCount++;
          console.log(`[Cron] Granted ${credits} credits to account ${sub.account_id} (${sub.plan_type})`);
        } catch (subError: any) {
          failCount++;
          console.error(`[Cron] Failed to grant credits to ${sub.account_id}:`, subError);
          
          await sentry.captureException(subError, {
            tags: {
              cron_job: 'monthly_renewal',
              account_id: sub.account_id
            },
            extra: { subscription: sub }
          });
        }
      }

      console.log(`[Cron] Monthly renewal complete: ${successCount} success, ${failCount} failed`);
      
      await sentry.captureMessage(
        `Monthly renewal: ${successCount}/${subscriptions.length} successful`,
        'info',
        { tags: { cron_job: 'monthly_renewal' } }
      );
    } catch (error: any) {
      console.error('[Cron] Monthly renewal error:', error);
      await sentry.captureException(error, {
        tags: { cron_job: 'monthly_renewal' }
      });
      throw error;
    }
  }

  /**
   * Daily cleanup (2 AM UTC)
   * Removes old soft-deleted records and stale analyses
   */
  async dailyCleanup(): Promise<void> {
    console.log('[Cron] Starting daily cleanup...');
    const sentry = await getSentryService(this.env);
    
    sentry.addBreadcrumb('Daily cleanup started', 'cron', 'info');

    try {
      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

      let totalDeleted = 0;

      // 1. Hard delete leads soft-deleted >30 days ago
      const { data: leadsDeleted, error: leadsError } = await supabase
        .from('leads')
        .delete()
        .lt('deleted_at', thirtyDaysAgo)
        .not('deleted_at', 'is', null)
        .select('id');

      if (leadsError) {
        console.error('[Cron] Error deleting old leads:', leadsError);
      } else {
        totalDeleted += leadsDeleted?.length || 0;
        console.log(`[Cron] Deleted ${leadsDeleted?.length || 0} old leads`);
      }

      // 2. Hard delete business profiles soft-deleted >30 days ago
      const { data: profilesDeleted, error: profilesError } = await supabase
        .from('business_profiles')
        .delete()
        .lt('deleted_at', thirtyDaysAgo)
        .not('deleted_at', 'is', null)
        .select('id');

      if (profilesError) {
        console.error('[Cron] Error deleting old profiles:', profilesError);
      } else {
        totalDeleted += profilesDeleted?.length || 0;
        console.log(`[Cron] Deleted ${profilesDeleted?.length || 0} old business profiles`);
      }

      // 3. Delete old completed analyses (>90 days)
      const { data: analysesDeleted, error: analysesError } = await supabase
        .from('analyses')
        .delete()
        .eq('status', 'complete')
        .lt('completed_at', ninetyDaysAgo)
        .select('id');

      if (analysesError) {
        console.error('[Cron] Error deleting old analyses:', analysesError);
      } else {
        totalDeleted += analysesDeleted?.length || 0;
        console.log(`[Cron] Deleted ${analysesDeleted?.length || 0} old analyses`);
      }

      // 4. Delete abandoned pending analyses (>24 hours)
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      
      const { data: pendingDeleted, error: pendingError } = await supabase
        .from('analyses')
        .delete()
        .eq('status', 'pending')
        .lt('created_at', twentyFourHoursAgo)
        .select('id');

      if (pendingError) {
        console.error('[Cron] Error deleting pending analyses:', pendingError);
      } else {
        totalDeleted += pendingDeleted?.length || 0;
        console.log(`[Cron] Deleted ${pendingDeleted?.length || 0} abandoned pending analyses`);
      }

      console.log(`[Cron] Daily cleanup complete: ${totalDeleted} total records deleted`);
      
      await sentry.captureMessage(
        `Daily cleanup: ${totalDeleted} records deleted`,
        'info',
        { tags: { cron_job: 'daily_cleanup' } }
      );
    } catch (error: any) {
      console.error('[Cron] Daily cleanup error:', error);
      await sentry.captureException(error, {
        tags: { cron_job: 'daily_cleanup' }
      });
      throw error;
    }
  }

  /**
   * Hourly failed analysis cleanup
   * Retries failed analyses (up to 3 attempts) and refunds credits
   */
  async hourlyFailedAnalysisCleanup(): Promise<void> {
    console.log('[Cron] Starting failed analysis cleanup...');
    const sentry = await getSentryService(this.env);
    
    sentry.addBreadcrumb('Failed analysis cleanup started', 'cron', 'info');

    try {
      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      // Get failed analyses from last hour
      // ✅ FIXED: Changed credits_used → credits_charged
      const { data: failedAnalyses, error } = await supabase
        .from('analyses')
        .select('id, account_id, credits_charged, created_at, retry_count')
        .eq('status', 'failed')
        .gt('created_at', oneHourAgo)
        .is('deleted_at', null);

      if (error) throw error;

      if (!failedAnalyses || failedAnalyses.length === 0) {
        console.log('[Cron] No failed analyses found');
        return;
      }

      console.log(`[Cron] Processing ${failedAnalyses.length} failed analyses`);

      const creditsRepo = new CreditsRepository(supabase);
      let refundedCount = 0;
      let retriedCount = 0;

      for (const analysis of failedAnalyses) {
        try {
          const retryCount = analysis.retry_count || 0;
          
          // Retry if attempts < 3
          if (retryCount < 3) {
            // TODO: Re-queue analysis via ANALYSIS_QUEUE
            console.log(`[Cron] Would retry analysis ${analysis.id} (attempt ${retryCount + 1})`);
            
            await supabase
              .from('analyses')
              .update({
                retry_count: retryCount + 1,
                status: 'pending'
              })
              .eq('id', analysis.id);
            
            retriedCount++;
          } else {
            // Max retries reached - refund credits
            // ✅ FIXED: Changed analysis.credits_used → analysis.credits_charged
            if (analysis.credits_charged > 0) {
              await creditsRepo.addCredits(
                analysis.account_id,
                analysis.credits_charged,
                'refund',
                `Analysis ${analysis.id} failed after 3 attempts`
              );

              refundedCount++;
              console.log(`[Cron] Refunded ${analysis.credits_charged} credits for analysis ${analysis.id}`);
            }

            // Mark as permanently failed
            await supabase
              .from('analyses')
              .update({ status: 'failed_permanent' })
              .eq('id', analysis.id);
          }
        } catch (analysisError: any) {
          console.error(`[Cron] Failed to process analysis ${analysis.id}:`, analysisError);
          
          await sentry.captureException(analysisError, {
            tags: {
              cron_job: 'failed_analysis_cleanup',
              analysis_id: analysis.id
            }
          });
        }
      }

      console.log(`[Cron] Failed analysis cleanup complete: ${retriedCount} retried, ${refundedCount} refunded`);
      
      await sentry.captureMessage(
        `Failed analysis cleanup: ${retriedCount} retried, ${refundedCount} refunded`,
        'info',
        { tags: { cron_job: 'failed_analysis_cleanup' } }
      );
    } catch (error: any) {
      console.error('[Cron] Failed analysis cleanup error:', error);
      await sentry.captureException(error, {
        tags: { cron_job: 'failed_analysis_cleanup' }
      });
      throw error;
    }
  }
}

/**
 * Execute cron job based on schedule
 */
export async function executeCronJob(cronExpression: string, env: Env): Promise<void> {
  const handler = new CronJobsHandler(env);

  try {
    switch (cronExpression) {
      case '0 3 1 * *': // Monthly renewal (1st of month, 3 AM UTC)
        await handler.monthlyRenewal();
        break;
      
      case '0 2 * * *': // Daily cleanup (2 AM UTC)
        await handler.dailyCleanup();
        break;
      
      case '0 * * * *': // Hourly failed analysis cleanup
        await handler.hourlyFailedAnalysisCleanup();
        break;
      
      default:
        console.warn('[Cron] Unknown cron expression:', cronExpression);
    }
  } catch (error) {
    console.error('[Cron] Job execution failed:', error);
    throw error;
  }
}
