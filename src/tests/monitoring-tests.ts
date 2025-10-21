// src/tests/monitoring-tests.ts
import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { CostTracker } from '@/infrastructure/monitoring/cost-tracker.service';
import { PerformanceTracker } from '@/infrastructure/monitoring/performance-tracker.service';

export function registerMonitoringTests(app: Hono<{ Bindings: Env }>) {

  app.get('/test/monitoring/cost-tracker', async (c) => {
    try {
      const costTracker = new CostTracker();
      costTracker.trackApify(8000, 0.0006);
      costTracker.trackAICall('gpt-5-nano', 'openai', 500, 150, 0.0012, 2000, 'test_analysis');
      costTracker.trackAICall('gpt-5-mini', 'openai', 800, 300, 0.0025, 3000, 'test_outreach');

      const breakdown = costTracker.getBreakdown();
      const margin = costTracker.calculateMargin(5);

      return c.json({
        success: true,
        test: 'Cost Tracker',
        breakdown,
        margin,
        summary: costTracker.getSummary(5)
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/monitoring/performance-tracker', async (c) => {
    try {
      const perfTracker = new PerformanceTracker();

      perfTracker.startStep('scraping');
      await new Promise(resolve => setTimeout(resolve, 100));
      perfTracker.endStep('scraping');

      perfTracker.startStep('ai_analysis');
      await new Promise(resolve => setTimeout(resolve, 200));
      perfTracker.endStep('ai_analysis');

      perfTracker.startStep('save_results');
      await new Promise(resolve => setTimeout(resolve, 50));
      perfTracker.endStep('save_results');

      const breakdown = perfTracker.getBreakdown();

      return c.json({
        success: true,
        test: 'Performance Tracker',
        breakdown,
        summary: perfTracker.getSummary()
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });
}
