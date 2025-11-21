// infrastructure/cron/cron-jobs.handler.ts

import type { Env } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { getSentryService } from '@/infrastructure/monitoring/sentry.service';

/**
 * CRON JOBS HANDLER
 *
 * Handles all scheduled tasks:
 * 1. Daily free plan credit reset (midnight UTC)
 * 2. Monthly credit renewal (subscriptions)
 * 3. Daily cleanup (old analyses, soft deleted records)
 * 4. Hourly failed analysis refunds
 */

export class CronJobsHandler {
  constructor(private env: Env) {}

  /**
   * Daily free plan credit reset (midnight UTC)
   * Atomically resets credits for free-tier accounts whose billing cycle has ended
   * Uses Supabase RPC function for transaction safety and idempotency
   */
  async resetFreePlanCredits(): Promise<void> {
    console.log('[Cron] Starting free plan credit reset...');
    const sentry = await getSentryService(this.env);

    sentry.addBreadcrumb('Free plan credit reset started', 'cron', 'info');

    try {
      const supabase = await SupabaseClientFactory.createAdminClient(this.env);

      // Call Supabase RPC function that handles the entire reset atomically
      const { data, error } = await supabase.rpc('reset_free_plan_credits');

      if (error) {
        throw new Error(`RPC call failed: ${error.message}`);
      }

      const result = data as {
        success: boolean;
        processed: number;
        skipped: number;
        errors: string[];
        plan_credits: number;
        plan_light_analyses: number;
        executed_at: string;
      };

      if (!result.success) {
        throw new Error(`Reset failed: ${JSON.stringify(result)}`);
      }

      console.log('[Cron] Free plan credit reset complete:', {
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors.length,
        plan_credits: result.plan_credits,
        plan_light_analyses: result.plan_light_analyses
      });

      // Log errors if any accounts failed
      if (result.errors.length > 0) {
        console.warn('[Cron] Some accounts failed to reset:', result.errors);

        await sentry.captureMessage(
          `Free plan reset: ${result.errors.length} accounts failed`,
          'warning',
          {
            tags: { cron_job: 'free_plan_reset' },
            extra: { errors: result.errors }
          }
        );
      }

      // Track success metrics in Analytics Engine
      if (this.env.ANALYTICS_ENGINE) {
        this.env.ANALYTICS_ENGINE.writeDataPoint({
          blobs: ['free_plan_reset', 'success'],
          doubles: [result.processed, result.skipped],
          indexes: [new Date().toISOString().split('T')[0]]
        });
      }

      await sentry.captureMessage(
        `Free plan reset: ${result.processed} accounts processed, ${result.skipped} skipped`,
        'info',
        { tags: { cron_job: 'free_plan_reset' } }
      );

    } catch (error: any) {
      console.error('[Cron] Free plan credit reset error:', error);

      await sentry.captureException(error, {
        tags: { cron_job: 'free_plan_reset' }
      });

      throw error;
    }
  }

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
    
    // Get all active subscriptions with their plan details
    const { data: subscriptions, error } = await supabase
      .from('subscriptions')
      .select(`
        account_id,
        plan_type,
        plans!inner(
          credits_per_month,
          features
        )
      `)
      .eq('status', 'active')
      .is('deleted_at', null);

    if (error) throw error;

    if (!subscriptions || subscriptions.length === 0) {
      console.log('[Cron] No active subscriptions found');
      return;
    }

    console.log(`[Cron] Processing ${subscriptions.length} active subscriptions`);

    let successCount = 0;
    let failCount = 0;

    for (const sub of subscriptions) {
      try {
        const plan = sub.plans;
        const creditsQuota = plan.credits_per_month;
        const lightQuota = parseInt(plan.features.light_analyses);

        // Reset both balances
        const { error: updateError } = await supabase
          .from('balances')
          .update({
            credit_balance: creditsQuota,
            light_analyses_balance: lightQuota,
            last_transaction_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          })
          .eq('account_id', sub.account_id);

        if (updateError) throw updateError;

        // Update subscription period
        await supabase
          .from('subscriptions')
          .update({
            current_period_start: new Date().toISOString(),
            current_period_end: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
          })
          .eq('account_id', sub.account_id);

        successCount++;
        console.log(
          `[Cron] Reset balances for ${sub.account_id} (${sub.plan_type}): ` +
          `${creditsQuota} credits + ${lightQuota} light analyses`
        );
      } catch (subError: any) {
        failCount++;
        console.error(`[Cron] Failed to reset ${sub.account_id}:`, subError);
        
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

      // 3. Hard delete old completed analyses (>90 days)
      const { data: analysesDeleted, error: analysesError } = await supabase
        .from('lead_analyses')
        .delete()
        .eq('status', 'complete')
        .lt('completed_at', ninetyDaysAgo)
        .select('id');

      if (analysesError) {
        console.error('[Cron] Error deleting old analyses:', analysesError);
      } else {
        totalDeleted += analysesDeleted?.length || 0;
        console.log(`[Cron] Deleted ${analysesDeleted?.length || 0} old completed analyses`);
      }

      // 4. Hard delete failed analyses (>30 days)
      const { data: failedDeleted, error: failedError } = await supabase
        .from('lead_analyses')
        .delete()
        .eq('status', 'failed')
        .lt('created_at', thirtyDaysAgo)
        .select('id');

      if (failedError) {
        console.error('[Cron] Error deleting failed analyses:', failedError);
      } else {
        totalDeleted += failedDeleted?.length || 0;
        console.log(`[Cron] Deleted ${failedDeleted?.length || 0} old failed analyses`);
      }

      // 5. Delete abandoned pending analyses (>24 hours)
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data: pendingDeleted, error: pendingError } = await supabase
        .from('lead_analyses')
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
   * Soft-deletes failed analyses older than 1 hour for audit purposes
   * Note: Credit refunds are handled automatically by the workflow error handler
   */
  async hourlyFailedAnalysisCleanup(): Promise<void> {
    console.log('[Cron] Starting failed analysis cleanup...');
    const sentry = await getSentryService(this.env);

    sentry.addBreadcrumb('Failed analysis cleanup started', 'cron', 'info');

    try {
      const supabase = await SupabaseClientFactory.createAdminClient(this.env);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      // Get failed analyses older than 1 hour that haven't been soft-deleted
      const { data: failedAnalyses, error } = await supabase
        .from('lead_analyses')
        .select('id, account_id, created_at')
        .eq('status', 'failed')
        .lt('created_at', oneHourAgo)
        .is('deleted_at', null);

      if (error) throw error;

      if (!failedAnalyses || failedAnalyses.length === 0) {
        console.log('[Cron] No failed analyses found');
        return;
      }

      console.log(`[Cron] Processing ${failedAnalyses.length} failed analyses`);

      let cleanedCount = 0;

      for (const analysis of failedAnalyses) {
        try {
          // Soft delete the failed analysis (keep for audit)
          await supabase
            .from('lead_analyses')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', analysis.id);

          cleanedCount++;
          console.log(`[Cron] Soft-deleted failed analysis ${analysis.id}`);

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

      console.log(`[Cron] Failed analysis cleanup complete: ${cleanedCount} analyses soft-deleted`);

      await sentry.captureMessage(
        `Failed analysis cleanup: ${cleanedCount} analyses cleaned`,
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
 *
 * NOTE: Cron triggers only run in PRODUCTION environment.
 * Staging and production share the same database, so running crons in both
 * would cause duplicate operations (double credit resets, double cleanups, etc).
 */
export async function executeCronJob(cronExpression: string, env: Env): Promise<void> {
  const handler = new CronJobsHandler(env);

  try {
    switch (cronExpression) {
      case '0 0 * * *': // Daily free plan credit reset (midnight UTC)
        await handler.resetFreePlanCredits();
        break;

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
