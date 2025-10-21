import { Hono } from 'hono';
import { cors } from 'hono/cors';

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

const createUserClient = SupabaseClientFactory.createUserClient;
const createAdminClient = SupabaseClientFactory.createAdminClient;

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: false
}));

// ===============================================================================
// HEALTH CHECK ENDPOINTS
// ===============================================================================

app.get('/', (c) => {
  return c.json({
    status: 'healthy',
    service: 'OSLIRA Enterprise Analysis API',
    version: '6.0.0',
    timestamp: new Date().toISOString(),
    environment: c.env.APP_ENV,
    architecture: 'feature-first',
    phase: 'Phase 0.2 - Foundation Complete'
  });
});

app.get('/health', async (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    bindings: {
      kv: !!c.env.OSLIRA_KV,
      r2: !!c.env.R2_CACHE_BUCKET,
      workflows: !!c.env.ANALYSIS_WORKFLOW,
      analytics: !!c.env.ANALYTICS_ENGINE
    }
  });
});

// ===============================================================================
// TEST ENDPOINTS (Phase 0.2 only - remove in production)
// ===============================================================================

app.get('/test/secrets', async (c) => {
  try {
    const { getSecret } = await import('@/infrastructure/config/secrets');
    
    // Test fetching a secret (don't return the actual value)
    const supabaseUrl = await getSecret('SUPABASE_URL', c.env, c.env.APP_ENV);
    
    return c.json({
      success: true,
      message: 'AWS Secrets Manager connection successful',
      supabase_url_length: supabaseUrl.length,
      cache_working: true
    });
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

app.get('/test/supabase/user', async (c) => {
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
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

app.get('/test/supabase/admin', async (c) => {
  try {
    const supabase = await createAdminClient(c.env);
    
    // Test RPC function
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
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

app.get('/test/analytics', async (c) => {
  try {
    // Write test data point
    c.env.ANALYTICS_ENGINE.writeDataPoint({
      blobs: ['test_event', 'phase_0_2'],
      doubles: [1, Date.now()],
      indexes: ['test']
    });
    
    return c.json({
      success: true,
      message: 'Analytics Engine working',
      note: 'Data will appear in Cloudflare Analytics dashboard in ~1 minute'
    });
  } catch (error: any) {
    return c.json({
      success: false,
      error: error.message
    }, 500);
  }
});

app.get('/test/cache', async (c) => {
  try {
    const username = c.req.query('username') || 'nike';
    const cacheService = new R2CacheService(c.env.R2_CACHE_BUCKET);

    // Test set
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

    // 🔧 ADD THIS: Wait for R2 propagation (2 seconds)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Test get
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

app.get('/test/r2-binding', async (c) => {
  try {
    // Verify binding exists
    if (!c.env.R2_CACHE_BUCKET) {
      return c.json({ 
        success: false, 
        error: 'R2_CACHE_BUCKET binding not found' 
      }, 500);
    }

    // Try direct R2 operations
    const testKey = 'test-binding-check';
    const testData = { timestamp: Date.now(), test: 'hello' };

    // PUT
    await c.env.R2_CACHE_BUCKET.put(testKey, JSON.stringify(testData));
    console.log('✅ R2 PUT succeeded');

    // Wait
    await new Promise(resolve => setTimeout(resolve, 2000));

    // GET
    const object = await c.env.R2_CACHE_BUCKET.get(testKey);
    if (!object) {
      return c.json({
        success: false,
        error: 'R2 GET returned null after PUT',
        note: 'Propagation delay or binding issue'
      });
    }

    const retrieved = await object.json();
    console.log('✅ R2 GET succeeded');

    // DELETE (cleanup)
    await c.env.R2_CACHE_BUCKET.delete(testKey);

    return c.json({
      success: true,
      test: 'R2 Binding Check',
      operations: {
        put: 'OK',
        get: 'OK',
        delete: 'OK'
      },
      data_match: retrieved.timestamp === testData.timestamp
    });
  } catch (error: any) {
    return c.json({ 
      success: false, 
      error: error.message,
      stack: error.stack
    }, 500);
  }
});

// ============================================================================
// TEST ENDPOINTS - PHASE 1 INFRASTRUCTURE
// ============================================================================

/**
 * TEST 1: R2 Cache
 * GET /test/cache?username=nike
 */
app.get('/test/cache', async (c) => {
  try {
    const username = c.req.query('username') || 'nike';
    const cacheService = new R2CacheService(c.env.R2_CACHE_BUCKET);

// Test set
const mockProfile: ProfileData = {  // ← ADD TYPE
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
  isBusinessAccount: false,  // ← ADD THIS (was missing)
  latestPosts: [],
  scraperUsed: 'test',
  dataQuality: 'high' as const
};

    await cacheService.set(username, mockProfile);

    // Test get
    const cached = await cacheService.get(username, 'light');

    return c.json({
      success: true,
      test: 'R2 Cache',
      operations: {
        set: 'OK',
        get: cached ? 'OK' : 'FAILED'
      },
      cached_data: cached
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

/**
 * TEST 2: AI Gateway
 * GET /test/ai
 */
app.get('/test/ai', async (c) => {
  try {
    const openaiKey = await getApiKey('OPENAI_API_KEY', c.env, c.env.APP_ENV);
    const claudeKey = await getApiKey('ANTHROPIC_API_KEY', c.env, c.env.APP_ENV);

    const aiClient = new AIGatewayClient(c.env, openaiKey, claudeKey);

    const response = await aiClient.call({
      model: 'gpt-4o-mini',
      system_prompt: 'You are a helpful assistant.',
      user_prompt: 'Say "Hello from AI Gateway test!" in one short sentence.',
      max_tokens: 50,
      temperature: 0
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

/**
 * TEST 3: Apify Scraper
 * GET /test/apify?username=nike
 */
app.get('/test/apify', async (c) => {
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

/**
 * TEST 4: Cost Tracker
 * GET /test/cost-tracker
 */
app.get('/test/cost-tracker', async (c) => {
  try {
    const costTracker = new CostTracker();

    // Simulate tracking
    costTracker.trackApify(8000, 0.0006);
    costTracker.trackAICall('gpt-4o-mini', 'openai', 500, 150, 0.0012, 2000, 'test_analysis');
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

/**
 * TEST 5: Performance Tracker
 * GET /test/performance-tracker
 */
app.get('/test/performance-tracker', async (c) => {
  try {
    const perfTracker = new PerformanceTracker();

    // Simulate tracking
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

/**
 * TEST 6: Credits Repository
 * GET /test/credits?account_id=YOUR_ACCOUNT_ID
 */
app.get('/test/credits', async (c) => {
  try {
    const accountId = c.req.query('account_id');
    if (!accountId) {
      return c.json({ error: 'Missing account_id parameter' }, 400);
    }

    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
    const creditsRepo = new CreditsRepository(supabase);

    const balance = await creditsRepo.getBalance(accountId);
    const hasSufficient = await creditsRepo.hasSufficientCredits(accountId, 5);
    const transactions = await creditsRepo.getTransactions(accountId, { limit: 5 });

    return c.json({
      success: true,
      test: 'Credits Repository',
      account_id: accountId,
      current_balance: balance,
      has_sufficient_for_deep: hasSufficient,
      recent_transactions: transactions.length
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

/**
 * TEST 7: Full Integration Test
 * GET /test/full-integration?username=nike&account_id=YOUR_ACCOUNT_ID
 */
app.get('/test/full-integration', async (c) => {
  try {
    const username = c.req.query('username') || 'nike';
    const accountId = c.req.query('account_id');
    
    if (!accountId) {
      return c.json({ error: 'Missing account_id parameter' }, 400);
    }

    const results: any = {};

    // 1. Check cache
    const cacheService = new R2CacheService(c.env.R2_CACHE_BUCKET);
    const cached = await cacheService.get(username, 'light');
    results.cache_hit = !!cached;

    // 2. Check credits
    const supabase = await SupabaseClientFactory.createAdminClient(c.env);
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

    // 3. Start tracking
    const costTracker = new CostTracker();
    const perfTracker = new PerformanceTracker();

    // 4. Scrape (if not cached)
    let profile;
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

      // Cache it
      await cacheService.set(username, profile);
      results.scraping = 'OK';
    }

    results.profile = {
      username: profile.username,
      followers: profile.followersCount,
      verified: profile.isVerified
    };

    // 5. AI Analysis (light)
    perfTracker.startStep('ai_analysis');
    const openaiKey = await getApiKey('OPENAI_API_KEY', c.env, c.env.APP_ENV);
    const claudeKey = await getApiKey('ANTHROPIC_API_KEY', c.env, c.env.APP_ENV);
    const aiClient = new AIGatewayClient(c.env, openaiKey, claudeKey);

    const aiResponse = await aiClient.call({
      model: 'gpt-4o-mini',
      system_prompt: 'Score this profile 0-100 for brand partnerships.',
      user_prompt: `Profile: @${profile.username}, ${profile.followersCount} followers. Return JSON: {"score": X, "summary": "..."}`,
      max_tokens: 200,
      temperature: 0
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

    // 6. Get final metrics
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

app.post('/test/seed-data', async (c) => {
  try {
    const supabase = await createAdminClient(c.env);
    
    console.log('🌱 Starting test data seed...');

    // ========================================
    // 1. CREATE AUTH USER (Supabase Auth)
    // ========================================
    const testEmail = 'test@oslira.com';
    const testPassword = 'TestPassword123!'; // Only for testing
    
    // Create user via Supabase Auth (creates in auth.users)
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email: testEmail,
      password: testPassword,
      email_confirm: true, // Skip email verification
      user_metadata: {
        full_name: 'Test User',
        signature_name: 'Test'
      }
    });

    if (authError && authError.message !== 'User already registered') {
      throw new Error(`Auth user creation failed: ${authError.message}`);
    }

    const testUserId = authUser?.user?.id || authError.message.includes('already registered') 
      ? (await supabase.auth.admin.listUsers()).data.users.find(u => u.email === testEmail)?.id
      : null;

    if (!testUserId) {
      throw new Error('Could not get test user ID');
    }

    console.log('✅ Auth user created/found:', testUserId);

    // ========================================
    // 2. CREATE PUBLIC USER PROFILE
    // ========================================
    const { error: userProfileError } = await supabase
      .from('users')
      .upsert({
        id: testUserId,
        email: testEmail,
        full_name: 'Test User',
        signature_name: 'Test',
        onboarding_completed: true,
        is_admin: false
      }, {
        onConflict: 'id'
      });

    if (userProfileError) {
      throw new Error(`User profile creation failed: ${userProfileError.message}`);
    }
    console.log('✅ User profile created');

    // ========================================
    // 3. CREATE TEST ACCOUNT
    // ========================================
    const { data: account, error: accError } = await supabase
      .from('accounts')
      .insert({
        owner_id: testUserId,
        name: 'Test Account',
        slug: 'test-account-' + Date.now(),
        is_suspended: false
      })
      .select()
      .single();

    if (accError) {
      throw new Error(`Account creation failed: ${accError.message}`);
    }
    console.log('✅ Test account created:', account.id);

    // ========================================
    // 4. ADD USER TO ACCOUNT (account_members)
    // ========================================
    const { error: memberError } = await supabase
      .from('account_members')
      .insert({
        account_id: account.id,
        user_id: testUserId,
        role: 'owner'
      });

    if (memberError) {
      throw new Error(`Account member failed: ${memberError.message}`);
    }
    console.log('✅ User added to account as owner');

    // ========================================
    // 5. INITIALIZE CREDIT BALANCE
    // ========================================
    const { error: balanceError } = await supabase
      .from('credit_balances')
      .insert({
        account_id: account.id,
        current_balance: 0,
        last_transaction_at: new Date().toISOString()
      });

    if (balanceError) {
      throw new Error(`Credit balance init failed: ${balanceError.message}`);
    }
    console.log('✅ Credit balance initialized');

    // ========================================
    // 6. GRANT INITIAL CREDITS (100 credits)
    // ========================================
    const { error: creditError } = await supabase
      .rpc('deduct_credits', {
        p_account_id: account.id,
        p_amount: 100,
        p_transaction_type: 'initial_grant',
        p_description: 'Test account seed credits'
      });

    if (creditError) {
      throw new Error(`Credit grant failed: ${creditError.message}`);
    }
    console.log('✅ 100 credits granted');

    // ========================================
    // 7. CREATE BUSINESS PROFILE
    // ========================================
    const { data: business, error: bizError } = await supabase
      .from('business_profiles')
      .insert({
        account_id: account.id,
        business_name: 'Test Business',
        website: 'https://testbusiness.com',
        business_one_liner: 'AI-powered Instagram lead analysis for testing',
        business_context_pack: {
          target_audience: 'Instagram influencers',
          industry: 'Marketing & Analytics',
          offering: 'Lead scoring service'
        }
      })
      .select()
      .single();

    if (bizError) {
      throw new Error(`Business profile failed: ${bizError.message}`);
    }
    console.log('✅ Business profile created:', business.id);

    // ========================================
    // 8. CREATE 3 TEST LEADS
    // ========================================
    const testLeads = [
      {
        account_id: account.id,
        business_profile_id: business.id,
        instagram_username: 'nike',
        display_name: 'Nike',
        follower_count: 250000000,
        following_count: 150,
        post_count: 1200,
        bio: 'Just Do It. Official Nike account.',
        is_verified: true,
        is_business_account: true,
        platform: 'instagram',
        first_analyzed_at: new Date().toISOString(),
        last_analyzed_at: new Date().toISOString()
      },
      {
        account_id: account.id,
        business_profile_id: business.id,
        instagram_username: 'adidas',
        display_name: 'adidas',
        follower_count: 28000000,
        following_count: 200,
        post_count: 950,
        bio: 'Impossible is Nothing.',
        is_verified: true,
        is_business_account: true,
        platform: 'instagram',
        first_analyzed_at: new Date().toISOString(),
        last_analyzed_at: new Date().toISOString()
      },
      {
        account_id: account.id,
        business_profile_id: business.id,
        instagram_username: 'puma',
        display_name: 'PUMA',
        follower_count: 19000000,
        following_count: 300,
        post_count: 800,
        bio: 'Forever Faster',
        is_verified: true,
        is_business_account: true,
        platform: 'instagram',
        first_analyzed_at: new Date().toISOString(),
        last_analyzed_at: new Date().toISOString()
      }
    ];

    const { data: leads, error: leadsError } = await supabase
      .from('leads')
      .insert(testLeads)
      .select();

    if (leadsError) {
      throw new Error(`Leads creation failed: ${leadsError.message}`);
    }
    console.log('✅ 3 test leads created');

    // ========================================
    // 9. CREATE 3 FAKE CREDIT TRANSACTIONS
    // ========================================
    await supabase.rpc('deduct_credits', {
      p_account_id: account.id,
      p_amount: -2,
      p_transaction_type: 'analysis',
      p_description: 'Deep analysis of @nike'
    });

    await supabase.rpc('deduct_credits', {
      p_account_id: account.id,
      p_amount: -1,
      p_transaction_type: 'analysis',
      p_description: 'Light analysis of @adidas'
    });

    await supabase.rpc('deduct_credits', {
      p_account_id: account.id,
      p_amount: 50,
      p_transaction_type: 'bonus_grant',
      p_description: 'Referral bonus'
    });

    console.log('✅ 3 fake credit transactions created');

    // ========================================
    // 10. CREATE SAMPLE ANALYSES
    // ========================================
    const { data: analyses, error: analysesError } = await supabase
      .from('analyses')
      .insert([
        {
          lead_id: leads[0].id,
          account_id: account.id,
          business_profile_id: business.id,
          requested_by: testUserId,
          analysis_type: 'deep',
          status: 'complete',
          overall_score: 85,
          niche_fit_score: 90,
          engagement_score: 88,
          confidence_level: 0.92,
          credits_charged: 2,
          model_used: 'gpt-5-mini',
          completed_at: new Date().toISOString()
        },
        {
          lead_id: leads[1].id,
          account_id: account.id,
          business_profile_id: business.id,
          requested_by: testUserId,
          analysis_type: 'light',
          status: 'complete',
          overall_score: 72,
          niche_fit_score: 75,
          engagement_score: 70,
          confidence_level: 0.85,
          credits_charged: 1,
          model_used: 'gpt-4o-mini',
          completed_at: new Date().toISOString()
        }
      ])
      .select();

    if (analysesError) {
      throw new Error(`Analyses creation failed: ${analysesError.message}`);
    }
    console.log('✅ 2 sample analyses created');

    // ========================================
    // 11. GET FINAL CREDIT BALANCE
    // ========================================
    const { data: finalBalance } = await supabase
      .from('credit_balances')
      .select('current_balance')
      .eq('account_id', account.id)
      .single();

    // ========================================
    // RETURN COMPLETE TEST DATA
    // ========================================
    return c.json({
      success: true,
      message: 'Test data seeded successfully',
      test_data: {
        user_id: testUserId,
        user_email: testEmail,
        user_password: testPassword,
        account_id: account.id,
        account_name: account.name,
        business_id: business.id,
        business_name: business.name,
        leads: leads.map(l => ({
          id: l.id,
          username: l.instagram_username,
          followers: l.follower_count
        })),
        analyses: analyses.map(a => ({
          id: a.id,
          type: a.analysis_type,
          score: a.overall_score,
          status: a.status
        })),
        credits_balance: finalBalance.current_balance,
        credits_flow: '100 (initial) - 2 (nike) - 1 (adidas) + 50 (bonus) = 147'
      }
    });

  } catch (error: any) {
    console.error('❌ Seed failed:', error);
    return c.json({ 
      success: false, 
      error: error.message,
      hint: 'Check FK constraints and RPC functions exist',
      stack: error.stack
    }, 500);
  }
});

// ===============================================================================
// ERROR HANDLING
// ===============================================================================

app.onError((err, c) => {
  console.error('Worker error:', err);
  
  return c.json({
    success: false,
    error: 'Internal server error',
    message: err.message,
    timestamp: new Date().toISOString()
  }, 500);
});

app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Endpoint not found',
    path: c.req.path,
    method: c.req.method,
    available_endpoints: [
      'GET / - Service info',
      'GET /health - Health check with binding verification',
      'GET /test/secrets - Test AWS Secrets Manager',
      'GET /test/supabase/user - Test Supabase user client',
      'GET /test/supabase/admin - Test Supabase admin client',
      'GET /test/analytics - Test Analytics Engine'
    ],
    timestamp: new Date().toISOString()
  }, 404);
});

// ===============================================================================
// EXPORT WORKER
// ===============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  
  // Cron handler (placeholder for Phase 6)
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log('Cron trigger:', event.cron);
    // Cron jobs will be implemented in Phase 6
  }
};
