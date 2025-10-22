// src/tests/api-tests.ts
import { Hono } from 'hono';
import type { Env } from '@/shared/types/env.types';
import { SupabaseClientFactory } from '@/infrastructure/database/supabase.client';

const createAdminClient = SupabaseClientFactory.createAdminClient;

export function registerApiTests(app: Hono<{ Bindings: Env }>) {

  // ===============================================================================
  // LEADS ENDPOINTS TESTS
  // ===============================================================================

  app.get('/test/api/leads/list', async (c) => {
    try {
      const accountId = c.req.query('account_id');
      if (!accountId) {
        return c.json({ error: 'Missing account_id parameter' }, 400);
      }

      // Get auth token from test account
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Call actual endpoint
      const response = await app.request(
        '/api/leads?page=1&pageSize=10',
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'List Leads',
        endpoint: 'GET /api/leads',
        response: data
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/api/leads/get-single', async (c) => {
    try {
      const leadId = c.req.query('lead_id');
      if (!leadId) {
        return c.json({ error: 'Missing lead_id parameter' }, 400);
      }

      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Call actual endpoint
      const response = await app.request(
        `/api/leads/${leadId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Get Single Lead',
        endpoint: `GET /api/leads/${leadId}`,
        response: data
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/api/leads/get-analyses', async (c) => {
    try {
      const leadId = c.req.query('lead_id');
      if (!leadId) {
        return c.json({ error: 'Missing lead_id parameter' }, 400);
      }

      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Call actual endpoint
      const response = await app.request(
        `/api/leads/${leadId}/analyses?limit=5`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Get Lead Analyses',
        endpoint: `GET /api/leads/${leadId}/analyses`,
        response: data
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.delete('/test/api/leads/delete', async (c) => {
    try {
      const leadId = c.req.query('lead_id');
      if (!leadId) {
        return c.json({ error: 'Missing lead_id parameter' }, 400);
      }

      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Call actual endpoint
      const response = await app.request(
        `/api/leads/${leadId}`,
        {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${token}`
          }
        },
        c.env
      );

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Delete Lead',
        endpoint: `DELETE /api/leads/${leadId}`,
        note: 'Soft delete - 30 day recovery window'
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  // ===============================================================================
  // BUSINESS PROFILES ENDPOINTS TESTS
  // ===============================================================================

  app.get('/test/api/business/list', async (c) => {
    try {
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Call actual endpoint
      const response = await app.request(
        '/api/business-profiles?page=1&pageSize=10',
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'List Business Profiles',
        endpoint: 'GET /api/business-profiles',
        response: data
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/api/business/get-single', async (c) => {
    try {
      const profileId = c.req.query('profile_id');
      if (!profileId) {
        return c.json({ error: 'Missing profile_id parameter' }, 400);
      }

      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Call actual endpoint
      const response = await app.request(
        `/api/business-profiles/${profileId}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Get Single Business Profile',
        endpoint: `GET /api/business-profiles/${profileId}`,
        response: data
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.post('/test/api/business/create', async (c) => {
    try {
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Test payload
      const testProfile = {
        business_name: 'Test Business ' + Date.now(),
        website: 'https://testbusiness.com',
        business_one_liner: 'AI-powered test business',
        business_context_pack: {
          target_audience: 'Test influencers',
          industry: 'Testing',
          offering: 'Test services',
          icp_min_followers: 1000,
          icp_max_followers: 100000,
          icp_content_themes: ['test', 'demo'],
          selling_points: ['Fast', 'Reliable', 'Affordable']
        }
      };

      // Call actual endpoint
      const response = await app.request(
        '/api/business-profiles',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(testProfile)
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Create Business Profile',
        endpoint: 'POST /api/business-profiles',
        response: data,
        note: 'Profile created - remember to clean up'
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.put('/test/api/business/update', async (c) => {
    try {
      const profileId = c.req.query('profile_id');
      if (!profileId) {
        return c.json({ error: 'Missing profile_id parameter' }, 400);
      }

      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Test payload
      const updateData = {
        business_one_liner: 'Updated test business description',
        business_context_pack: {
          target_audience: 'Updated target audience',
          icp_min_followers: 5000
        }
      };

      // Call actual endpoint
      const response = await app.request(
        `/api/business-profiles/${profileId}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(updateData)
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Update Business Profile',
        endpoint: `PUT /api/business-profiles/${profileId}`,
        response: data
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  // ===============================================================================
  // CREDITS ENDPOINTS TESTS
  // ===============================================================================

  app.get('/test/api/credits/balance', async (c) => {
    try {
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Call actual endpoint
      const response = await app.request(
        '/api/credits/balance',
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Get Credit Balance',
        endpoint: 'GET /api/credits/balance',
        response: data
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/api/credits/transactions', async (c) => {
    try {
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      // Call actual endpoint
      const response = await app.request(
        '/api/credits/transactions?page=1&pageSize=20',
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        },
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Get Credit Transactions',
        endpoint: 'GET /api/credits/transactions',
        response: data
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.get('/test/api/credits/pricing', async (c) => {
    try {
      const amount = c.req.query('amount') || '100';

      // Call actual endpoint (no auth required)
      const response = await app.request(
        `/api/credits/pricing?amount=${amount}`,
        {},
        c.env
      );

      const data = await response.json();

      return c.json({
        success: response.ok,
        status: response.status,
        test: 'Get Credit Pricing',
        endpoint: `GET /api/credits/pricing?amount=${amount}`,
        response: data,
        note: 'Public endpoint - no auth required'
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  app.post('/test/api/credits/purchase', async (c) => {
    try {
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      return c.json({
        success: false,
        test: 'Purchase Credits',
        endpoint: 'POST /api/credits/purchase',
        note: 'SKIPPED - Cannot test Stripe purchases in test mode without valid payment method',
        instructions: 'Use Stripe test cards in staging: https://stripe.com/docs/testing'
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });

  // ===============================================================================
  // INTEGRATION TEST - Full User Journey
  // ===============================================================================

  app.get('/test/api/full-journey', async (c) => {
    try {
      const token = c.req.header('Authorization')?.replace('Bearer ', '');
      if (!token) {
        return c.json({ error: 'Missing Authorization header' }, 401);
      }

      const results: any[] = [];

      // Step 1: Get credit balance
      let response = await app.request('/api/credits/balance', {
        headers: { 'Authorization': `Bearer ${token}` }
      }, c.env);
      results.push({ step: 1, endpoint: 'GET /api/credits/balance', status: response.status });

      // Step 2: List business profiles
      response = await app.request('/api/business-profiles', {
        headers: { 'Authorization': `Bearer ${token}` }
      }, c.env);
      const businesses = await response.json();
      results.push({ step: 2, endpoint: 'GET /api/business-profiles', status: response.status });

      // Step 3: List leads
      response = await app.request('/api/leads', {
        headers: { 'Authorization': `Bearer ${token}` }
      }, c.env);
      const leads = await response.json();
      results.push({ step: 3, endpoint: 'GET /api/leads', status: response.status });

      // Step 4: Get transactions
      response = await app.request('/api/credits/transactions', {
        headers: { 'Authorization': `Bearer ${token}` }
      }, c.env);
      results.push({ step: 4, endpoint: 'GET /api/credits/transactions', status: response.status });

      // Step 5: Get pricing (public)
      response = await app.request('/api/credits/pricing?amount=100', {}, c.env);
      results.push({ step: 5, endpoint: 'GET /api/credits/pricing', status: response.status });

      const allPassed = results.every(r => r.status === 200);

      return c.json({
        success: allPassed,
        test: 'Full User Journey',
        description: 'Tests complete flow: balance → profiles → leads → transactions → pricing',
        results,
        summary: {
          total_steps: results.length,
          passed: results.filter(r => r.status === 200).length,
          failed: results.filter(r => r.status !== 200).length
        }
      });

    } catch (error: any) {
      return c.json({ success: false, error: error.message }, 500);
    }
  });
}
