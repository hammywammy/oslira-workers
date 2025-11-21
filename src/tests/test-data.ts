// src/tests/test-data.ts
import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';

const createAdminClient = SupabaseClientFactory.createAdminClient;

export function registerTestDataEndpoints(app: Hono<{ Bindings: Env }>) {

  app.post('/test/data/seed', async (c) => {
    try {
      const supabase = await createAdminClient(c.env);
      console.log('🌱 Starting test data seed...');

      const testEmail = 'test@oslira.com';
      const testPassword = 'TestPassword123!';
      
      const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
        email: testEmail,
        password: testPassword,
        email_confirm: true,
        user_metadata: { full_name: 'Test User', signature_name: 'Test' }
      });

      let testUserId;
      if (authError && authError.message.includes('already registered')) {
        const { data: { users } } = await supabase.auth.admin.listUsers();
        testUserId = users.find(u => u.email === testEmail)?.id;
      } else if (authError) {
        throw new Error(`Auth user creation failed: ${authError.message}`);
      } else {
        testUserId = authUser.user.id;
      }

      if (!testUserId) throw new Error('Could not get test user ID');

      await supabase.from('users').upsert({
        id: testUserId,
        email: testEmail,
        full_name: 'Test User',
        signature_name: 'Test',
        onboarding_completed: true,
        is_admin: false
      }, { onConflict: 'id' });

      const { data: account } = await supabase.from('accounts').insert({
        owner_id: testUserId,
        name: 'Test Account',
        slug: 'test-account-' + Date.now(),
        is_suspended: false
      }).select().single();

      await supabase.from('account_members').insert({
        account_id: account.id,
        user_id: testUserId,
        role: 'owner'
      });

      await supabase.from('credit_balances').insert({
        account_id: account.id,
        credit_balance: 0,
        light_analyses_balance: 0,
        last_transaction_at: new Date().toISOString()
      });

      await supabase.rpc('deduct_credits', {
        p_account_id: account.id,
        p_amount: 100,
        p_transaction_type: 'admin_grant',
        p_description: 'Test account seed credits'
      });

      const { data: business } = await supabase.from('business_profiles').insert({
        account_id: account.id,
        business_name: 'Test Business',
        website: 'https://testbusiness.com',
        business_one_liner: 'AI-powered Instagram lead analysis for testing',
        business_context_pack: {
          target_audience: 'Instagram influencers',
          industry: 'Marketing & Analytics',
          offering: 'Lead scoring service'
        }
      }).select().single();

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

      const { data: leads } = await supabase.from('leads').insert(testLeads).select();

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
        p_transaction_type: 'signup_bonus',
        p_description: 'Referral bonus'
      });

      const { data: analyses } = await supabase.from('analyses').insert([
        {
          lead_id: leads[0].id,
          account_id: account.id,
          business_profile_id: business.id,
          requested_by: testUserId,
          analysis_type: 'deep',
          status: 'completed',
          overall_score: 85,
          niche_fit_score: 90,
          engagement_score: 88,
          confidence_level: 0.92,
          completed_at: new Date().toISOString()
        },
        {
          lead_id: leads[1].id,
          account_id: account.id,
          business_profile_id: business.id,
          requested_by: testUserId,
          analysis_type: 'light',
          status: 'completed',
          overall_score: 72,
          niche_fit_score: 75,
          engagement_score: 70,
          confidence_level: 0.85,
          completed_at: new Date().toISOString()
        }
      ]).select();

      const { data: finalBalance } = await supabase
        .from('credit_balances')
        .select('credit_balance')
        .eq('account_id', account.id)
        .single();

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
          credits_balance: finalBalance.credit_balance,
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

  app.delete('/test/data/cleanup', async (c) => {
    try {
      const supabase = await createAdminClient(c.env);
      const testEmail = 'test@oslira.com';

      const { data: users } = await supabase.auth.admin.listUsers();
      const testUser = users.users.find(u => u.email === testEmail);
      
      if (!testUser) {
        return c.json({
          success: true,
          message: 'No test user found - nothing to clean up'
        });
      }

      const testUserId = testUser.id;
      await supabase.from('analyses').delete().eq('requested_by', testUserId);

      const { data: accounts } = await supabase
        .from('accounts')
        .select('id')
        .eq('owner_id', testUserId);

      if (accounts && accounts.length > 0) {
        const accountIds = accounts.map(a => a.id);
        await supabase.from('leads').delete().in('account_id', accountIds);
        await supabase.from('business_profiles').delete().in('account_id', accountIds);
        await supabase.from('credit_ledger').delete().in('account_id', accountIds);
        await supabase.from('credit_balances').delete().in('account_id', accountIds);
        await supabase.from('account_members').delete().in('account_id', accountIds);
        await supabase.from('accounts').delete().in('id', accountIds);
      }

      await supabase.from('users').delete().eq('id', testUserId);
      await supabase.auth.admin.deleteUser(testUserId);

      return c.json({
        success: true,
        message: 'Test data cleaned up successfully',
        deleted: { user_id: testUserId, user_email: testEmail }
      });

    } catch (error: any) {
      console.error('❌ Cleanup failed:', error);
      return c.json({ 
        success: false, 
        error: error.message,
        stack: error.stack
      }, 500);
    }
  });
}
