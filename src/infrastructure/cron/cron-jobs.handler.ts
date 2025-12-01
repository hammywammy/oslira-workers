// infrastructure/cron/cron-jobs.handler.ts

import type { Env } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { getSentryService } from '@/infrastructure/monitoring/sentry.service';
import { logger } from '@/shared/utils/logger.util';

/**
 * CRON JOBS HANDLER
 *
 * Handles all scheduled tasks:
 * 1. Daily free plan credit reset (midnight UTC)
 * 2. Daily refresh token cleanup (1 AM UTC)
 * 3. Monthly credit renewal (subscriptions)
 * 4. Daily cleanup (old analyses, soft deleted records)
 * 5. Hourly failed analysis refunds
 */

export class CronJobsHandler {
  constructor(private env: Env) {}

  /**
   * Daily free plan credit reset (midnight UTC)
   * Atomically resets credits for free-tier accounts whose billing cycle has ended
   * Uses Supabase RPC function for transaction safety and idempotency
   */
  async resetFreePlanCredits(): Promise<void> {
    logger.info('Starting free plan credit reset');
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

      logger.info('Free plan credit reset complete', {
        processed: result.processed,
        skipped: result.skipped,
        errorsCount: result.errors.length,
        planCredits: result.plan_credits,
        planLightAnalyses: result.plan_light_analyses
      });

      // Log errors if any accounts failed
      if (result.errors.length > 0) {
        logger.warn('Some accounts failed to reset', { errors: result.errors });

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
      logger.error('Free plan credit reset error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

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
    logger.info('Starting monthly credit renewal');
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
        logger.info('No active subscriptions found for monthly renewal');
        return;
      }

      logger.info('Processing active subscriptions', { count: subscriptions.length });

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
          logger.info('Reset balances for account', {
            accountId: sub.account_id,
            planType: sub.plan_type,
            credits: creditsQuota,
            lightAnalyses: lightQuota
          });
        } catch (subError: any) {
          failCount++;
          logger.error('Failed to reset account balances', {
            accountId: sub.account_id,
            error: subError instanceof Error ? subError.message : String(subError)
          });

          await sentry.captureException(subError, {
            tags: {
              cron_job: 'monthly_renewal',
              account_id: sub.account_id
            },
            extra: { subscription: sub }
          });
        }
      }

      logger.info('Monthly renewal complete', { successCount, failCount });

      await sentry.captureMessage(
        `Monthly renewal: ${successCount}/${subscriptions.length} successful`,
        'info',
        { tags: { cron_job: 'monthly_renewal' } }
      );
    } catch (error: any) {
      logger.error('Monthly renewal error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
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
    logger.info('Starting daily cleanup');
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
        logger.error('Error deleting old leads', { error: leadsError.message });
      } else {
        totalDeleted += leadsDeleted?.length || 0;
        logger.info('Deleted old leads', { count: leadsDeleted?.length || 0 });
      }

      // 2. Hard delete business profiles soft-deleted >30 days ago
      const { data: profilesDeleted, error: profilesError } = await supabase
        .from('business_profiles')
        .delete()
        .lt('deleted_at', thirtyDaysAgo)
        .not('deleted_at', 'is', null)
        .select('id');

      if (profilesError) {
        logger.error('Error deleting old profiles', { error: profilesError.message });
      } else {
        totalDeleted += profilesDeleted?.length || 0;
        logger.info('Deleted old business profiles', { count: profilesDeleted?.length || 0 });
      }

      // 3. Hard delete old completed analyses (>90 days)
      const { data: analysesDeleted, error: analysesError } = await supabase
        .from('lead_analyses')
        .delete()
        .eq('status', 'complete')
        .lt('completed_at', ninetyDaysAgo)
        .select('id');

      if (analysesError) {
        logger.error('Error deleting old analyses', { error: analysesError.message });
      } else {
        totalDeleted += analysesDeleted?.length || 0;
        logger.info('Deleted old completed analyses', { count: analysesDeleted?.length || 0 });
      }

      // 4. Hard delete failed analyses (>30 days)
      const { data: failedDeleted, error: failedError } = await supabase
        .from('lead_analyses')
        .delete()
        .eq('status', 'failed')
        .lt('created_at', thirtyDaysAgo)
        .select('id');

      if (failedError) {
        logger.error('Error deleting failed analyses', { error: failedError.message });
      } else {
        totalDeleted += failedDeleted?.length || 0;
        logger.info('Deleted old failed analyses', { count: failedDeleted?.length || 0 });
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
        logger.error('Error deleting pending analyses', { error: pendingError.message });
      } else {
        totalDeleted += pendingDeleted?.length || 0;
        logger.info('Deleted abandoned pending analyses', { count: pendingDeleted?.length || 0 });
      }

      logger.info('Daily cleanup complete', { totalDeleted });

      await sentry.captureMessage(
        `Daily cleanup: ${totalDeleted} records deleted`,
        'info',
        { tags: { cron_job: 'daily_cleanup' } }
      );
    } catch (error: any) {
      logger.error('Daily cleanup error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
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
    logger.info('Starting failed analysis cleanup');
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
        logger.info('No failed analyses found for cleanup');
        return;
      }

      logger.info('Processing failed analyses', { count: failedAnalyses.length });

      let cleanedCount = 0;

      for (const analysis of failedAnalyses) {
        try {
          // Soft delete the failed analysis (keep for audit)
          await supabase
            .from('lead_analyses')
            .update({ deleted_at: new Date().toISOString() })
            .eq('id', analysis.id);

          cleanedCount++;
          logger.info('Soft-deleted failed analysis', { analysisId: analysis.id });

        } catch (analysisError: any) {
          logger.error('Failed to process analysis', {
            analysisId: analysis.id,
            error: analysisError instanceof Error ? analysisError.message : String(analysisError)
          });

          await sentry.captureException(analysisError, {
            tags: {
              cron_job: 'failed_analysis_cleanup',
              analysis_id: analysis.id
            }
          });
        }
      }

      logger.info('Failed analysis cleanup complete', { cleanedCount });

      await sentry.captureMessage(
        `Failed analysis cleanup: ${cleanedCount} analyses cleaned`,
        'info',
        { tags: { cron_job: 'failed_analysis_cleanup' } }
      );
    } catch (error: any) {
      logger.error('Failed analysis cleanup error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      await sentry.captureException(error, {
        tags: { cron_job: 'failed_analysis_cleanup' }
      });
      throw error;
    }
  }

  /**
   * Daily refresh token cleanup (1 AM UTC)
   * Removes revoked and expired refresh tokens to keep table clean
   */
  async cleanupRefreshTokens(): Promise<void> {
    logger.info('Starting refresh token cleanup');
    const sentry = await getSentryService(this.env);

    sentry.addBreadcrumb('Refresh token cleanup started', 'cron', 'info');

    try {
      const supabase = await SupabaseClientFactory.createAdminClient(this.env);

      // Delete revoked tokens (revoked_at IS NOT NULL)
      const { count: revokedCount, error: revokedError } = await supabase
        .from('refresh_tokens')
        .delete()
        .not('revoked_at', 'is', null)
        .select('*', { count: 'exact', head: true });

      if (revokedError) {
        logger.error('Failed to delete revoked tokens', { error: revokedError.message });
        throw revokedError;
      }

      // Delete expired tokens (expires_at < NOW())
      const { count: expiredCount, error: expiredError } = await supabase
        .from('refresh_tokens')
        .delete()
        .lt('expires_at', new Date().toISOString())
        .select('*', { count: 'exact', head: true });

      if (expiredError) {
        logger.error('Failed to delete expired tokens', { error: expiredError.message });
        throw expiredError;
      }

      const totalDeleted = (revokedCount || 0) + (expiredCount || 0);

      logger.info('Refresh token cleanup complete', {
        revokedDeleted: revokedCount || 0,
        expiredDeleted: expiredCount || 0,
        totalDeleted
      });

      // Track metrics in Analytics Engine
      if (this.env.ANALYTICS_ENGINE) {
        this.env.ANALYTICS_ENGINE.writeDataPoint({
          blobs: ['refresh_token_cleanup', 'success'],
          doubles: [revokedCount || 0, expiredCount || 0],
          indexes: [new Date().toISOString().split('T')[0]],
        });
      }

      await sentry.captureMessage(
        `Refresh token cleanup: ${totalDeleted} tokens deleted (${revokedCount} revoked, ${expiredCount} expired)`,
        'info',
        { tags: { cron_job: 'refresh_token_cleanup' } }
      );

    } catch (error: any) {
      logger.error('Refresh token cleanup error', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      await sentry.captureException(error, {
        tags: { cron_job: 'refresh_token_cleanup' },
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

      case '0 1 * * *': // Daily refresh token cleanup (1 AM UTC)
        await handler.cleanupRefreshTokens();
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
        logger.warn('Unknown cron expression', { cronExpression });
    }
  } catch (error) {
    logger.error('Cron job execution failed', {
      cronExpression,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    throw error;
  }
}
