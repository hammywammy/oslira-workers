// infrastructure/monitoring/analytics.service.ts

import type { Env } from '@/shared/types/env.types';
import type { CostBreakdown } from './cost-tracker.service';
import type { PerformanceBreakdown } from './performance-tracker.service';

/**
 * ANALYTICS ENGINE SERVICE
 * 
 * Writes metrics to Cloudflare Analytics Engine for dashboards
 * 
 * Metrics tracked:
 * - Analysis costs (per run, per model, per provider)
 * - Performance timings (per step, bottlenecks)
 * - Credit usage (per account, per analysis type)
 * - Error rates (per endpoint, per error type)
 * - API usage (rate limits, quotas)
 */

export interface AnalysisCostMetric {
  timestamp: Date;
  run_id: string;
  account_id: string;
  business_profile_id: string;
  analysis_type: 'light';  // Extensible - add more types as needed
  username: string;

  // Costs
  apify_cost: number;
  total_ai_cost: number;
  total_cost: number;
  openai_cost: number;
  anthropic_cost: number;

  // Cache
  cache_hit: boolean;

  // Status
  status: 'complete' | 'failed' | 'cancelled';
}

export interface PerformanceMetric {
  timestamp: Date;
  run_id: string;
  account_id: string;
  analysis_type: 'light';  // Extensible - add more types as needed
  
  // Timings
  total_duration_ms: number;
  scraping_duration_ms: number;
  ai_duration_ms: number;
  db_duration_ms: number;
  
  // Bottleneck
  bottleneck_step: string;
  bottleneck_duration_ms: number;
  
  // Status
  status: 'complete' | 'failed' | 'cancelled';
}

export interface ErrorMetric {
  timestamp: Date;
  error_type: string;
  error_message: string;
  endpoint: string;
  method: string;
  status_code: number;
  account_id?: string;
  
  // Context
  user_agent?: string;
  ip_address?: string;
  request_id?: string;
}

export interface CreditUsageMetric {
  timestamp: Date;
  account_id: string;
  transaction_type: 'purchase' | 'analysis' | 'refund' | 'subscription' | 'bonus';
  credits_amount: number;
  credits_balance_after: number;
  analysis_type?: 'light';  // Extensible - add more types as needed
  cost_usd?: number;
}

export class AnalyticsService {
  constructor(private env: Env) {}

  /**
   * Write analysis cost metrics
   */
  async writeAnalysisCost(data: {
    run_id: string;
    account_id: string;
    business_profile_id: string;
    analysis_type: 'light';
    username: string;
    cost_breakdown: CostBreakdown;
    cache_hit: boolean;
    status: 'complete' | 'failed' | 'cancelled';
  }): Promise<void> {
    try {
      const metric: AnalysisCostMetric = {
        timestamp: new Date(),
        run_id: data.run_id,
        account_id: data.account_id,
        business_profile_id: data.business_profile_id,
        analysis_type: data.analysis_type,
        username: data.username,
        apify_cost: data.cost_breakdown.apify_cost,
        total_ai_cost: data.cost_breakdown.total_ai_cost,
        total_cost: data.cost_breakdown.total_cost,
        openai_cost: data.cost_breakdown.cost_by_provider.openai,
        anthropic_cost: data.cost_breakdown.cost_by_provider.anthropic,
        cache_hit: data.cache_hit,
        status: data.status
      };

      await this.writeDataPoint('analysis_costs', metric);

      console.log('[Analytics] Analysis cost written:', {
        run_id: data.run_id,
        total_cost: data.cost_breakdown.total_cost
      });
    } catch (error) {
      console.error('[Analytics] Failed to write analysis cost:', error);
    }
  }

  /**
   * Write performance metrics
   */
  async writePerformance(data: {
    run_id: string;
    account_id: string;
    analysis_type: 'light';
    performance: PerformanceBreakdown;
    status: 'complete' | 'failed' | 'cancelled';
  }): Promise<void> {
    try {
      const scrapingStep = data.performance.steps.find(s => s.step === 'scraping' || s.step === 'get_profile');
      const aiStep = data.performance.steps.find(s => s.step.includes('ai_') || s.step === 'analysis');
      const dbStep = data.performance.steps.find(s => s.step.includes('save_') || s.step.includes('upsert_'));

      const metric: PerformanceMetric = {
        timestamp: new Date(),
        run_id: data.run_id,
        account_id: data.account_id,
        analysis_type: data.analysis_type,
        total_duration_ms: data.performance.total_duration_ms,
        scraping_duration_ms: scrapingStep?.duration_ms || 0,
        ai_duration_ms: aiStep?.duration_ms || 0,
        db_duration_ms: dbStep?.duration_ms || 0,
        bottleneck_step: data.performance.bottleneck.step,
        bottleneck_duration_ms: data.performance.bottleneck.duration_ms,
        status: data.status
      };

      await this.writeDataPoint('analysis_performance', metric);
      
      console.log('[Analytics] Performance written:', {
        run_id: data.run_id,
        total_ms: data.performance.total_duration_ms,
        bottleneck: data.performance.bottleneck.step
      });
    } catch (error) {
      console.error('[Analytics] Failed to write performance:', error);
    }
  }

  /**
   * Write error metrics
   */
  async writeError(data: {
    error_type: string;
    error_message: string;
    endpoint: string;
    method: string;
    status_code: number;
    account_id?: string;
    user_agent?: string;
    ip_address?: string;
    request_id?: string;
  }): Promise<void> {
    try {
      const metric: ErrorMetric = {
        timestamp: new Date(),
        ...data
      };

      await this.writeDataPoint('errors', metric);
      
      console.log('[Analytics] Error written:', {
        type: data.error_type,
        endpoint: data.endpoint
      });
    } catch (error) {
      console.error('[Analytics] Failed to write error:', error);
    }
  }

  /**
   * Write credit usage metrics
   */
  async writeCreditUsage(data: {
    account_id: string;
    transaction_type: 'purchase' | 'analysis' | 'refund' | 'subscription' | 'bonus';
    credits_amount: number;
    credits_balance_after: number;
    analysis_type?: 'light';
    cost_usd?: number;
  }): Promise<void> {
    try {
      const metric: CreditUsageMetric = {
        timestamp: new Date(),
        ...data
      };

      await this.writeDataPoint('credit_usage', metric);
      
      console.log('[Analytics] Credit usage written:', {
        account_id: data.account_id,
        type: data.transaction_type,
        amount: data.credits_amount
      });
    } catch (error) {
      console.error('[Analytics] Failed to write credit usage:', error);
    }
  }

  /**
   * Write generic data point to Analytics Engine
   */
  private async writeDataPoint(index: string, data: Record<string, any>): Promise<void> {
    if (!this.env.ANALYTICS_ENGINE) {
      console.warn('[Analytics] Analytics Engine not configured');
      return;
    }

    try {
      // Convert all data to doubles for Analytics Engine
      const doubles: Record<string, number> = {};
      const blobs: string[] = [];

      for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'number') {
          doubles[key] = value;
        } else if (typeof value === 'boolean') {
          doubles[key] = value ? 1 : 0;
        } else if (value instanceof Date) {
          doubles['timestamp_ms'] = value.getTime();
        } else if (typeof value === 'string') {
          blobs.push(`${key}:${value}`);
        }
      }

      // Write to Analytics Engine
      this.env.ANALYTICS_ENGINE.writeDataPoint({
        indexes: [index],
        doubles,
        blobs
      });
    } catch (error) {
      console.error('[Analytics] Error writing data point:', error);
    }
  }

  /**
   * Batch write multiple data points
   */
  async batchWrite(dataPoints: Array<{ index: string; data: Record<string, any> }>): Promise<void> {
    for (const point of dataPoints) {
      await this.writeDataPoint(point.index, point.data);
    }
  }
}

/**
 * Singleton helper
 */
let analyticsInstance: AnalyticsService | null = null;

export function getAnalyticsService(env: Env): AnalyticsService {
  if (!analyticsInstance) {
    analyticsInstance = new AnalyticsService(env);
  }
  return analyticsInstance;
}
