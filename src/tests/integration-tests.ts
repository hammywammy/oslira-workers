// src/tests/integration-tests.ts
import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type { ProfileData } from '@/shared/types/analysis.types';
import { R2CacheService } from '@/infrastructure/cache/r2-cache.service';
import { AIGatewayClient } from '@/infrastructure/ai/ai-gateway.client';
import { ApifyAdapter } from '@/infrastructure/scraping/apify.adapter';
import { CostTracker } from '@/infrastructure/monitoring/cost-tracker.service';
import { PerformanceTracker } from '@/infrastructure/monitoring/performance-tracker.service';
import { CreditsRepository } from '@/infrastructure/database/repositories/credits.repository';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { getApiKey } from '@/infrastructure/config/secrets';

const createAdminClient = SupabaseClientFactory.createAdminClient;

export function registerIntegrationTests(app: Hono<{ Bindings: Env }>) {

  app.get('/test/integration/full-flow', async (c) => {
    try {
      const username = c.req.query('username') || 'nike';
      const accountId = c.req.query('account_id');
      
      if (!accountId) {
        return c.json({ error: 'Missing account_id parameter' }, 400);
      }

      const results: any = {};
      const cacheService = new R2CacheService(c.env.R2_CACHE_BUCKET);
      const cached = await cacheService.get(username, 'light');
      results.cache_hit = !!cached;

      const supabase = await createAdminClient(c.env);
      const creditsRepo = new CreditsRepository(supabase);
      const balance = await creditsRepo.getBalance(accountId);
      results.credit_balance = balance;
      results.has_sufficient_credits = balance >= 1;

      if (balance < 1) {
        return c.json({
          success: false,
          error: 'Insufficient credits for test',
          results
        }, 400);
      }

      const costTracker = new CostTracker();
      const perfTracker = new PerformanceTracker();

      let profile: ProfileData;
      if (cached) {
        profile = cached;
        results.scraping = 'SKIPPED (cached)';
      } else {
        perfTracker.startStep('scraping');
        const apifyToken = await getApiKey('APIFY_API_TOKEN', c.env, c.env.APP_ENV);
        const apify = new ApifyAdapter(apifyToken);
        const scrapedData = await apify.scrapeProfile(username, 'light');
        perfTracker.endStep('scraping');

        profile = scrapedData.profile;
        costTracker.trackApify(scrapedData.duration_ms, scrapedData.cost);
        await cacheService.set(username, profile);
        results.scraping = 'OK';
      }

      results.profile = {
        username: profile.username,
        followers: profile.followersCount,
        verified: profile.isVerified
      };

      perfTracker.startStep('ai_analysis');
      const openaiKey = await getApiKey('OPENAI_API_KEY', c.env, c.env.APP_ENV);
      const claudeKey = await getApiKey('ANTHROPIC_API_KEY', c.env, c.env.APP_ENV);
      const aiGatewayToken = await getApiKey('CLOUDFLARE_AI_GATEWAY_TOKEN', c.env, c.env.APP_ENV);
      const aiClient = new AIGatewayClient(c.env, openaiKey, claudeKey, aiGatewayToken);

      const aiResponse = await aiClient.call({
        model: 'gpt-5-nano',
        system_prompt: 'Score this profile 0-100 for brand partnerships.',
        user_prompt: `Profile: @${profile.username}, ${profile.followersCount} followers. Return JSON: {"score": X, "summary": "..."}`,
        max_tokens: 200
      });
      perfTracker.endStep('ai_analysis');

      costTracker.trackAICall(
        aiResponse.model_used,
        aiResponse.provider,
        aiResponse.usage.input_tokens,
        aiResponse.usage.output_tokens,
        aiResponse.usage.total_cost,
        0,
        'light_analysis'
      );

      results.ai_response = aiResponse.content.substring(0, 100);

      const costBreakdown = costTracker.getBreakdown();
      const perfBreakdown = perfTracker.getBreakdown();
      const margin = costTracker.calculateMargin(1);

      return c.json({
        success: true,
        test: 'Full Integration',
        results,
        cost: {
          total: costBreakdown.total_cost,
          apify: costBreakdown.apify_cost,
          ai: costBreakdown.total_ai_cost,
          margin: margin.gross_profit
        },
        performance: {
          total_ms: perfBreakdown.total_duration_ms,
          bottleneck: perfBreakdown.bottleneck.step
        }
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });
}
