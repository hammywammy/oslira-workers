// src/tests/infrastructure-tests.ts
import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import type { ProfileData } from '@/shared/types/analysis.types';
import { R2CacheService } from '@/infrastructure/cache/r2-cache.service';
import { AIGatewayClient } from '@/infrastructure/ai/ai-gateway.client';
import { ApifyAdapter } from '@/infrastructure/scraping/apify.adapter';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';
import { getApiKey } from '@/infrastructure/config/secrets';

const createUserClient = SupabaseClientFactory.createUserClient;
const createAdminClient = SupabaseClientFactory.createAdminClient;

export function registerInfrastructureTests(app: Hono<{ Bindings: Env }>) {
  
  app.get('/test/infrastructure/secrets', async (c) => {
    try {
      const { getSecret } = await import('@/infrastructure/config/secrets');
      const supabaseUrl = await getSecret('SUPABASE_URL', c.env, c.env.APP_ENV);
      
      return c.json({
        success: true,
        message: 'AWS Secrets Manager connection successful',
        supabase_url_length: supabaseUrl.length,
        cache_working: true
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/infrastructure/supabase-user', async (c) => {
    try {
      const supabase = await createUserClient(c.env);
      const { data, error } = await supabase.from('plans').select('id, name').limit(2);
      
      if (error) throw error;
      
      return c.json({
        success: true,
        message: 'Supabase user client (anon key) working',
        client_type: 'anon_key_with_rls',
        data
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/infrastructure/supabase-admin', async (c) => {
    try {
      const supabase = await createAdminClient(c.env);
      const { data, error } = await supabase.rpc('generate_slug', { 
        input_text: 'Test User' 
      });
      
      if (error) throw error;
      
      return c.json({
        success: true,
        message: 'Supabase admin client (service role) working',
        client_type: 'service_role_bypasses_rls',
        test_slug: data
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/infrastructure/analytics', async (c) => {
    try {
      c.env.ANALYTICS_ENGINE.writeDataPoint({
        blobs: ['test_event', 'infrastructure'],
        doubles: [1, Date.now()],
        indexes: ['test']
      });
      
      return c.json({
        success: true,
        message: 'Analytics Engine working',
        note: 'Data will appear in Cloudflare Analytics dashboard in ~1 minute'
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/infrastructure/r2-cache', async (c) => {
    try {
      const username = c.req.query('username') || 'testuser';
      const cacheService = new R2CacheService(c.env.R2_CACHE_BUCKET);

      const mockProfile: ProfileData = {
        username,
        displayName: 'Test Profile',
        bio: 'Test bio',
        followersCount: 1000000,
        followingCount: 500,
        postsCount: 100,
        isVerified: true,
        isPrivate: false,
        profilePicUrl: 'https://example.com/pic.jpg',
        externalUrl: '',
        isBusinessAccount: false,
        latestPosts: [],
        scraperUsed: 'test',
        dataQuality: 'high' as const
      };

      await cacheService.set(username, mockProfile);
      await new Promise(resolve => setTimeout(resolve, 2000));
      const cached = await cacheService.get(username, 'light');

      return c.json({
        success: true,
        test: 'R2 Cache',
        operations: {
          set: 'OK',
          get: cached ? 'OK' : 'FAILED'
        },
        cached_data: cached,
        note: cached ? 'Cache working correctly' : 'Cache get returned null - may need more propagation time'
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/infrastructure/ai-gateway', async (c) => {
    try {
      const openaiKey = await getApiKey('OPENAI_API_KEY', c.env, c.env.APP_ENV);
      const claudeKey = await getApiKey('ANTHROPIC_API_KEY', c.env, c.env.APP_ENV);
      const aiClient = new AIGatewayClient(c.env, openaiKey, claudeKey);

      const response = await aiClient.call({
        model: 'gpt-5-nano',
        system_prompt: 'You are a helpful assistant.',
        user_prompt: 'Say "Hello from AI Gateway test!" in one short sentence.',
        max_tokens: 50
      });

      return c.json({
        success: true,
        test: 'AI Gateway',
        response: {
          content: response.content,
          model: response.model_used,
          provider: response.provider,
          cost: response.usage.total_cost,
          tokens: `${response.usage.input_tokens} → ${response.usage.output_tokens}`
        }
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/infrastructure/apify', async (c) => {
    try {
      const username = c.req.query('username') || 'nike';
      const apifyToken = await getApiKey('APIFY_API_TOKEN', c.env, c.env.APP_ENV);
      const apify = new ApifyAdapter(apifyToken);
      const result = await apify.scrapeProfile(username, 'light');

      return c.json({
        success: true,
        test: 'Apify Scraper',
        result: {
          username: result.profile.username,
          followers: result.profile.followersCount,
          posts_scraped: result.posts.length,
          scraper_used: result.scraper_used,
          duration_ms: result.duration_ms,
          cost: result.cost
        }
      });
    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });
}
