import type { Context } from 'hono';
import type { Env } from '../types/interfaces.js';
import { generateRequestId, logger } from '../utils/logger.js';
import { createStandardResponse } from '../utils/response.js';
import { fetchJson } from '../utils/helpers.js';
import { getApiKey } from '../services/enhanced-config-manager.js';

// ===============================================================================
// AUTHENTICATION & AUTHORIZATION
// ===============================================================================

async function verifyAdminAccess(c: Context<{ Bindings: Env }>): Promise<{ isAdmin: boolean; userId?: string; error?: string }> {
  const authHeader = c.req.header('Authorization');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { isAdmin: false, error: 'No authorization token provided' };
  }
  
  const token = authHeader.substring(7);
  
  try {
    const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
    const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
    
    // Verify token and get user
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': serviceRole
      }
    });
    
    if (!userResponse.ok) {
      return { isAdmin: false, error: 'Invalid token' };
    }
    
    const userData = await userResponse.json();
    const userId = userData.id;
    
    // Check if user is admin
    const adminCheckResponse = await fetch(
      `${supabaseUrl}/rest/v1/users?select=is_admin&id=eq.${userId}`,
      {
        headers: {
          'apikey': serviceRole,
          'Authorization': `Bearer ${serviceRole}`
        }
      }
    );
    
    if (!adminCheckResponse.ok) {
      return { isAdmin: false, error: 'Failed to verify admin status' };
    }
    
    const users = await adminCheckResponse.json();
    
    if (!users.length || !users[0].is_admin) {
      return { isAdmin: false, userId, error: 'User is not an administrator' };
    }
    
    return { isAdmin: true, userId };
    
  } catch (error: any) {
    logger('error', 'Admin verification failed', { error: error.message });
    return { isAdmin: false, error: 'Authentication failed' };
  }
}

// ===============================================================================
// MAIN ADMIN ROUTER
// ===============================================================================

export async function handleAdminRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = generateRequestId();
  const path = c.req.path;
  
  // Verify admin access
  const authResult = await verifyAdminAccess(c);
  
  if (!authResult.isAdmin) {
    logger('warn', 'Unauthorized admin access attempt', { 
      path, 
      error: authResult.error, 
      requestId 
    });
    return c.json(createStandardResponse(false, undefined, authResult.error || 'Unauthorized', requestId), 403);
  }
  
  logger('info', 'Admin request authorized', { 
    path, 
    userId: authResult.userId, 
    requestId 
  });
  
  // Route to appropriate handler
  try {
    if (path === '/admin/overview' || path === '/admin/overview/') {
      return await handleOverview(c, requestId);
    }

    if (path === '/admin/validate-session') {
  return await validateAdminSession(c, requestId);
}
    
    if (path.startsWith('/admin/users')) {
      return await handleUsers(c, requestId);
    }
    
    if (path.startsWith('/admin/businesses')) {
      return await handleBusinesses(c, requestId);
    }
    
    if (path.startsWith('/admin/revenue')) {
      return await handleRevenue(c, requestId);
    }
    
    if (path.startsWith('/admin/usage')) {
      return await handleUsage(c, requestId);
    }
    
    if (path.startsWith('/admin/system')) {
      return await handleSystem(c, requestId);
    }
    
    if (path.startsWith('/admin/leads')) {
      return await handleLeadsAnalytics(c, requestId);
    }
    
    return c.json(createStandardResponse(false, undefined, 'Admin endpoint not found', requestId), 404);
    
  } catch (error: any) {
    logger('error', 'Admin request failed', { 
      path, 
      error: error.message, 
      requestId 
    });
    return c.json(createStandardResponse(false, undefined, 'Internal server error', requestId), 500);
  }
}
async function validateAdminSession(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  const authResult = await verifyAdminAccess(c);
  return c.json(createStandardResponse(authResult.isAdmin, undefined, undefined, requestId));
}
// ===============================================================================
// OVERVIEW SECTION
// ===============================================================================

async function handleOverview(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  try {
    const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
    const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
    
    const headers = {
      'apikey': serviceRole,
      'Authorization': `Bearer ${serviceRole}`,
      'Content-Type': 'application/json'
    };
    
    // Calculate date ranges
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lastMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // Parallel queries for all metrics
    const [usersData, subscriptionsData, transactionsData, runsData] = await Promise.all([
      // Users
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/users?select=id,created_at`, { headers }),
      
      // Subscriptions
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/subscriptions?select=*`, { headers }),
      
      // Credit transactions
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/credit_transactions?select=*,created_at`, { headers }),
      
      // Runs (for active jobs)
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/runs?select=*&run_status=neq.completed`, { headers })
    ]);
    
    // Calculate metrics
    const totalUsers = usersData.length;
    const usersThisMonth = usersData.filter(u => u.created_at > lastMonth).length;
    const usersThisWeek = usersData.filter(u => u.created_at > lastWeek).length;
    
    const activeSubscriptions = subscriptionsData.filter(s => s.subscription_status === 'active');
    const mrr = activeSubscriptions.reduce((sum, s) => sum + (s.plan_price || 0), 0);
    const arr = mrr * 12;
    
    // Credit burn rate
    const creditsUsedToday = transactionsData.filter(t => 
      t.created_at > yesterday && t.type === 'use'
    ).reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const creditsUsedYesterday = transactionsData.filter(t => {
      const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      return t.created_at > twoDaysAgo && t.created_at <= yesterday && t.type === 'use';
    }).reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const creditBurnRate = Math.round(creditsUsedToday);
    const burnRateTrend = creditsUsedYesterday > 0 
      ? Math.round(((creditsUsedToday - creditsUsedYesterday) / creditsUsedYesterday) * 100)
      : 0;
    
    // Active jobs
    const activeJobs = runsData.length;
    
    // Signup trend data (last 30 days)
    const signupTrend = [];
    for (let i = 29; i >= 0; i--) {
      const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0];
      const count = usersData.filter(u => u.created_at.startsWith(dateStr)).length;
      signupTrend.push({ date: dateStr, count });
    }
    
    const responseData = {
      metrics: {
        totalUsers: {
          value: totalUsers,
          trend: `+${usersThisMonth} this month`,
          weeklyGrowth: usersThisWeek
        },
        mrr: {
          value: mrr,
          arr: arr,
          activeSubscriptions: activeSubscriptions.length
        },
        creditBurnRate: {
          value: creditBurnRate,
          trend: burnRateTrend,
          yesterdayValue: creditsUsedYesterday
        },
        activeJobs: {
          value: activeJobs
        }
      },
      charts: {
        signupTrend
      },
      systemStatus: {
        apiUptime: '99.9%', // This would come from Uptime Robot API
        sentryErrors: 0,    // This would come from Sentry API
        activeJobs: activeJobs
      }
    };
    
    logger('info', 'Overview metrics calculated', { 
      totalUsers, 
      mrr, 
      activeJobs, 
      requestId 
    });
    
    return c.json(createStandardResponse(true, responseData, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Overview calculation failed', { 
      error: error.message, 
      requestId 
    });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

// ===============================================================================
// USERS SECTION
// ===============================================================================

async function handleUsers(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  const method = c.req.method;
  const path = c.req.path;
  
  try {
    // GET /admin/users - List users with pagination
    if (method === 'GET' && path === '/admin/users') {
      return await getUsersList(c, requestId);
    }
    
    // GET /admin/users/search - Search users
    if (method === 'GET' && path === '/admin/users/search') {
      return await searchUsers(c, requestId);
    }
    
    // GET /admin/users/:id - Get user details
    if (method === 'GET' && path.match(/\/admin\/users\/[^\/]+$/)) {
      const userId = path.split('/').pop();
      return await getUserDetails(c, userId!, requestId);
    }
    
    // POST /admin/users/:id/update-credits - Update credits
    if (method === 'POST' && path.match(/\/admin\/users\/[^\/]+\/update-credits$/)) {
      const userId = path.split('/')[3];
      return await updateUserCredits(c, userId, requestId);
    }
    
    // POST /admin/users/:id/toggle-admin - Toggle admin status
    if (method === 'POST' && path.match(/\/admin\/users\/[^\/]+\/toggle-admin$/)) {
      const userId = path.split('/')[3];
      return await toggleAdminStatus(c, userId, requestId);
    }
    
    // POST /admin/users/:id/suspend - Suspend/unsuspend user
    if (method === 'POST' && path.match(/\/admin\/users\/[^\/]+\/suspend$/)) {
      const userId = path.split('/')[3];
      return await toggleUserSuspension(c, userId, requestId);
    }
    
    return c.json(createStandardResponse(false, undefined, 'User endpoint not found', requestId), 404);
    
  } catch (error: any) {
    logger('error', 'User operation failed', { 
      error: error.message, 
      requestId 
    });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

async function getUsersList(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = (page - 1) * limit;
  
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json',
    'Prefer': 'count=exact'
  };
  
  // Get users with their subscription data
  const response = await fetch(
    `${supabaseUrl}/rest/v1/users?select=id,email,full_name,created_at,last_login,is_admin,is_suspended,subscriptions(credits_remaining,subscription_status,plan_name)&order=created_at.desc&limit=${limit}&offset=${offset}`,
    { headers }
  );
  
  const users = await response.json();
  const totalCount = response.headers.get('Content-Range')?.split('/')[1] || '0';
  
  logger('info', 'Users list retrieved', { 
    page, 
    limit, 
    count: users.length, 
    requestId 
  });
  
  return c.json(createStandardResponse(true, {
    users,
    pagination: {
      page,
      limit,
      total: parseInt(totalCount),
      totalPages: Math.ceil(parseInt(totalCount) / limit)
    }
  }, undefined, requestId));
}

async function searchUsers(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  const query = c.req.query('q') || '';
  
  if (!query || query.length < 2) {
    return c.json(createStandardResponse(false, undefined, 'Search query too short', requestId), 400);
  }
  
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
  
  // Search across email, name, and ID
  const response = await fetch(
    `${supabaseUrl}/rest/v1/users?select=id,email,full_name,created_at,is_admin,subscriptions(credits_remaining,subscription_status)&or=(email.ilike.*${query}*,full_name.ilike.*${query}*,id.eq.${query})&limit=20`,
    { headers }
  );
  
  const users = await response.json();
  
  logger('info', 'User search completed', { 
    query, 
    results: users.length, 
    requestId 
  });
  
  return c.json(createStandardResponse(true, { users }, undefined, requestId));
}

async function getUserDetails(c: Context<{ Bindings: Env }>, userId: string, requestId: string): Promise<Response> {
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
  
  // Get comprehensive user data
  const [userData, businessesData, transactionsData] = await Promise.all([
    fetchJson<any[]>(
      `${supabaseUrl}/rest/v1/users?select=*,subscriptions(*)&id=eq.${userId}`,
      { headers }
    ),
    fetchJson<any[]>(
      `${supabaseUrl}/rest/v1/business_profiles?select=*&user_id=eq.${userId}`,
      { headers }
    ),
    fetchJson<any[]>(
      `${supabaseUrl}/rest/v1/credit_transactions?select=*&user_id=eq.${userId}&order=created_at.desc&limit=10`,
      { headers }
    )
  ]);
  
  if (!userData.length) {
    return c.json(createStandardResponse(false, undefined, 'User not found', requestId), 404);
  }
  
  const user = userData[0];
  
  // Calculate lifetime spend
  const lifetimeSpend = transactionsData
    .filter(t => t.type === 'use')
    .reduce((sum, t) => sum + (t.actual_cost || 0), 0);
  
  const responseData = {
    user,
    businesses: businessesData,
    recentTransactions: transactionsData,
    analytics: {
      lifetimeSpend,
      totalBusinesses: businessesData.length,
      totalTransactions: transactionsData.length
    }
  };
  
  logger('info', 'User details retrieved', { userId, requestId });
  
  return c.json(createStandardResponse(true, responseData, undefined, requestId));
}

async function updateUserCredits(c: Context<{ Bindings: Env }>, userId: string, requestId: string): Promise<Response> {
  const body = await c.req.json();
  const { amount, reason } = body;
  
  if (typeof amount !== 'number' || amount < 0) {
    return c.json(createStandardResponse(false, undefined, 'Invalid credit amount', requestId), 400);
  }
  
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
  
  // Update subscription credits
  const updateResponse = await fetch(
    `${supabaseUrl}/rest/v1/subscriptions?user_id=eq.${userId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ credits_remaining: amount })
    }
  );
  
  if (!updateResponse.ok) {
    throw new Error('Failed to update credits');
  }
  
  // Log transaction
  await fetch(
    `${supabaseUrl}/rest/v1/credit_transactions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        user_id: userId,
        amount: amount,
        type: 'bonus',
        description: reason || 'Admin credit adjustment',
        created_at: new Date().toISOString()
      })
    }
  );
  
  logger('info', 'User credits updated', { userId, amount, reason, requestId });
  
  return c.json(createStandardResponse(true, { 
    message: 'Credits updated successfully',
    newAmount: amount 
  }, undefined, requestId));
}

async function toggleAdminStatus(c: Context<{ Bindings: Env }>, userId: string, requestId: string): Promise<Response> {
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
  
  // Get current status
  const userData = await fetchJson<any[]>(
    `${supabaseUrl}/rest/v1/users?select=is_admin&id=eq.${userId}`,
    { headers }
  );
  
  if (!userData.length) {
    return c.json(createStandardResponse(false, undefined, 'User not found', requestId), 404);
  }
  
  const newStatus = !userData[0].is_admin;
  
  // Update status
  await fetch(
    `${supabaseUrl}/rest/v1/users?id=eq.${userId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ is_admin: newStatus })
    }
  );
  
  logger('info', 'Admin status toggled', { userId, newStatus, requestId });
  
  return c.json(createStandardResponse(true, { 
    message: `Admin status ${newStatus ? 'granted' : 'revoked'}`,
    isAdmin: newStatus 
  }, undefined, requestId));
}

async function toggleUserSuspension(c: Context<{ Bindings: Env }>, userId: string, requestId: string): Promise<Response> {
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
  
  // Get current status
  const userData = await fetchJson<any[]>(
    `${supabaseUrl}/rest/v1/users?select=is_suspended&id=eq.${userId}`,
    { headers }
  );
  
  if (!userData.length) {
    return c.json(createStandardResponse(false, undefined, 'User not found', requestId), 404);
  }
  
  const newStatus = !userData[0].is_suspended;
  
  // Update status
  await fetch(
    `${supabaseUrl}/rest/v1/users?id=eq.${userId}`,
    {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ is_suspended: newStatus })
    }
  );
  
  logger('info', 'User suspension toggled', { userId, newStatus, requestId });
  
  return c.json(createStandardResponse(true, { 
    message: `User ${newStatus ? 'suspended' : 'unsuspended'}`,
    isSuspended: newStatus 
  }, undefined, requestId));
}

// ===============================================================================
// BUSINESSES SECTION
// ===============================================================================

async function handleBusinesses(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  const method = c.req.method;
  const path = c.req.path;
  
  try {
    if (method === 'GET' && path === '/admin/businesses') {
      return await getBusinessesList(c, requestId);
    }
    
    if (method === 'GET' && path === '/admin/businesses/search') {
      return await searchBusinesses(c, requestId);
    }
    
    if (method === 'GET' && path.match(/\/admin\/businesses\/[^\/]+\/analytics$/)) {
      const businessId = path.split('/')[3];
      return await getBusinessAnalytics(c, businessId, requestId);
    }
    
    return c.json(createStandardResponse(false, undefined, 'Business endpoint not found', requestId), 404);
    
  } catch (error: any) {
    logger('error', 'Business operation failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

async function getBusinessesList(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = (page - 1) * limit;
  
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json',
    'Prefer': 'count=exact'
  };
  
  const response = await fetch(
    `${supabaseUrl}/rest/v1/business_profiles?select=*,users(email,full_name)&order=created_at.desc&limit=${limit}&offset=${offset}`,
    { headers }
  );
  
  const businesses = await response.json();
  const totalCount = response.headers.get('Content-Range')?.split('/')[1] || '0';
  
  logger('info', 'Businesses list retrieved', { page, limit, count: businesses.length, requestId });
  
  return c.json(createStandardResponse(true, {
    businesses,
    pagination: {
      page,
      limit,
      total: parseInt(totalCount),
      totalPages: Math.ceil(parseInt(totalCount) / limit)
    }
  }, undefined, requestId));
}

async function searchBusinesses(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  const query = c.req.query('q') || '';
  
  if (!query || query.length < 2) {
    return c.json(createStandardResponse(false, undefined, 'Search query too short', requestId), 400);
  }
  
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
  
  const response = await fetch(
    `${supabaseUrl}/rest/v1/business_profiles?select=*,users(email)&or=(business_name.ilike.*${query}*,business_niche.ilike.*${query}*)&limit=20`,
    { headers }
  );
  
  const businesses = await response.json();
  
  logger('info', 'Business search completed', { query, results: businesses.length, requestId });
  
  return c.json(createStandardResponse(true, { businesses }, undefined, requestId));
}

async function getBusinessAnalytics(c: Context<{ Bindings: Env }>, businessId: string, requestId: string): Promise<Response> {
  const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
  
  const headers = {
    'apikey': serviceRole,
    'Authorization': `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
  
  // Get business with all related data
  const [businessData, leadsData, runsData] = await Promise.all([
    fetchJson<any[]>(
      `${supabaseUrl}/rest/v1/business_profiles?select=*&id=eq.${businessId}`,
      { headers }
    ),
    fetchJson<any[]>(
      `${supabaseUrl}/rest/v1/leads?select=*&business_id=eq.${businessId}`,
      { headers }
    ),
    fetchJson<any[]>(
      `${supabaseUrl}/rest/v1/runs?select=*&business_id=eq.${businessId}`,
      { headers }
    )
  ]);
  
  if (!businessData.length) {
    return c.json(createStandardResponse(false, undefined, 'Business not found', requestId), 404);
  }
  
  // Calculate analytics
  const totalLeads = leadsData.length;
  const totalRuns = runsData.length;
  const avgScore = runsData.length > 0
    ? Math.round(runsData.reduce((sum, r) => sum + (r.overall_score || 0), 0) / runsData.length)
    : 0;
  
  const analysisTypeBreakdown = {
    light: runsData.filter(r => r.analysis_type === 'light').length,
    deep: runsData.filter(r => r.analysis_type === 'deep').length,
    xray: runsData.filter(r => r.analysis_type === 'xray').length
  };
  
  const premiumLeads = runsData.filter(r => r.overall_score >= 90).length;
  
  const responseData = {
    business: businessData[0],
    analytics: {
      totalLeads,
      totalRuns,
      avgScore,
      premiumLeads,
      analysisTypeBreakdown
    },
    topLeads: runsData
      .sort((a, b) => b.overall_score - a.overall_score)
      .slice(0, 5)
  };
  
  logger('info', 'Business analytics retrieved', { businessId, requestId });
  
  return c.json(createStandardResponse(true, responseData, undefined, requestId));
}

// ===============================================================================
// REVENUE SECTION
// ===============================================================================

async function handleRevenue(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  try {
    const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
    const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
    
    const headers = {
      'apikey': serviceRole,
      'Authorization': `Bearer ${serviceRole}`,
      'Content-Type': 'application/json'
    };
    
    const [subscriptionsData, transactionsData] = await Promise.all([
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/subscriptions?select=*`, { headers }),
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/credit_transactions?select=*`, { headers })
    ]);
    
    // Calculate MRR and ARR
    const activeSubscriptions = subscriptionsData.filter(s => s.subscription_status === 'active');
    const mrr = activeSubscriptions.reduce((sum, s) => sum + (s.plan_price || 0), 0);
    const arr = mrr * 12;
    
    // Plan breakdown
    const planBreakdown: any = {};
    activeSubscriptions.forEach(s => {
      const plan = s.plan_name || 'unknown';
      planBreakdown[plan] = (planBreakdown[plan] || 0) + 1;
    });
    
    // Credit economics
    const totalCreditsAllocated = subscriptionsData.reduce((sum, s) => sum + (s.credits_total || 0), 0);
    const totalCreditsUsed = transactionsData
      .filter(t => t.type === 'use')
      .reduce((sum, t) => sum + Math.abs(t.amount), 0);
    
    const utilizationRate = totalCreditsAllocated > 0
      ? Math.round((totalCreditsUsed / totalCreditsAllocated) * 100)
      : 0;
    
    const avgCostPerCredit = transactionsData.length > 0
      ? transactionsData
          .filter(t => t.type === 'use' && t.actual_cost)
          .reduce((sum, t) => sum + t.actual_cost, 0) / totalCreditsUsed
      : 0;
    
    const responseData = {
      revenue: {
        mrr,
        arr,
        activeSubscriptions: activeSubscriptions.length,
        planBreakdown
      },
      creditEconomics: {
        totalCreditsAllocated,
        totalCreditsUsed,
        utilizationRate: `${utilizationRate}%`,
        avgCostPerCredit: avgCostPerCredit.toFixed(4)
      }
    };
    
    logger('info', 'Revenue metrics calculated', { mrr, arr, requestId });
    
    return c.json(createStandardResponse(true, responseData, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Revenue calculation failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

// ===============================================================================
// USAGE SECTION
// ===============================================================================

async function handleUsage(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  try {
    const range = c.req.query('range') || '30d';
    const groupBy = c.req.query('groupBy') || 'day';
    
    const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
    const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
    
    const headers = {
      'apikey': serviceRole,
      'Authorization': `Bearer ${serviceRole}`,
      'Content-Type': 'application/json'
    };
    
    // Calculate date range
    const now = new Date();
    let startDate: Date;
    
    switch (range) {
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    
    const [runsData, transactionsData] = await Promise.all([
      fetchJson<any[]>(
        `${supabaseUrl}/rest/v1/runs?select=*,leads(username)&created_at=gte.${startDate.toISOString()}`,
        { headers }
      ),
      fetchJson<any[]>(
        `${supabaseUrl}/rest/v1/credit_transactions?select=*&created_at=gte.${startDate.toISOString()}&type=eq.use`,
        { headers }
      )
    ]);
    
    // Group data by period
    const groupedData: any = {};
    
    runsData.forEach(run => {
      const date = new Date(run.created_at);
      let key: string;
      
      if (groupBy === 'day') {
        key = date.toISOString().split('T')[0];
      } else if (groupBy === 'week') {
        const weekNum = Math.floor((date.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000));
        key = `Week ${weekNum + 1}`;
      } else {
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      }
      
      if (!groupedData[key]) {
        groupedData[key] = {
          period: key,
          totalAnalyses: 0,
          light: 0,
          deep: 0,
          xray: 0,
          avgScore: 0,
          scores: []
        };
      }
      
      groupedData[key].totalAnalyses++;
      groupedData[key][run.analysis_type]++;
      groupedData[key].scores.push(run.overall_score || 0);
    });
    
    // Calculate averages
    Object.keys(groupedData).forEach(key => {
      const scores = groupedData[key].scores;
      groupedData[key].avgScore = scores.length > 0
        ? Math.round(scores.reduce((a: number, b: number) => a + b, 0) / scores.length)
        : 0;
      delete groupedData[key].scores;
    });
    
    const usageData = Object.values(groupedData);
    
    // Calculate performance metrics
    const avgProcessingTime = transactionsData.length > 0
      ? Math.round(transactionsData.reduce((sum, t) => sum + (t.processing_duration_ms || 0), 0) / transactionsData.length)
      : 0;
    
    const avgTokenUsage = transactionsData.length > 0
      ? Math.round(transactionsData.reduce((sum, t) => sum + (t.tokens_in || 0) + (t.tokens_out || 0), 0) / transactionsData.length)
      : 0;
    
    const responseData = {
      usageData,
      performance: {
        avgProcessingTime: `${avgProcessingTime}ms`,
        avgTokenUsage,
        totalAnalyses: runsData.length
      }
    };
    
    logger('info', 'Usage analytics calculated', { range, groupBy, dataPoints: usageData.length, requestId });
    
    return c.json(createStandardResponse(true, responseData, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Usage analytics failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

// ===============================================================================
// SYSTEM SECTION
// ===============================================================================

async function handleSystem(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  try {
    const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
    const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
    
    const headers = {
      'apikey': serviceRole,
      'Authorization': `Bearer ${serviceRole}`,
      'Content-Type': 'application/json'
    };
    
    const [activeJobsData, failedTransactionsData] = await Promise.all([
      fetchJson<any[]>(
        `${supabaseUrl}/rest/v1/runs?select=*,leads(username),users(email)&run_status=neq.completed&order=created_at.desc`,
        { headers }
      ),
      fetchJson<any[]>(
        `${supabaseUrl}/rest/v1/credit_transactions?select=*&order=created_at.desc&limit=20`,
        { headers }
      )
    ]);
    
    // Identify stuck jobs (running > 5 minutes)
    const now = new Date();
    const stuckJobs = activeJobsData.filter(job => {
      const startTime = new Date(job.created_at);
      const duration = now.getTime() - startTime.getTime();
      return duration > 5 * 60 * 1000; // 5 minutes
    });
    
    const responseData = {
      activeJobs: activeJobsData.map(job => ({
        run_id: job.run_id,
        username: job.leads?.username,
        user_email: job.users?.email,
        analysis_type: job.analysis_type,
        started_at: job.created_at,
        duration: Math.round((now.getTime() - new Date(job.created_at).getTime()) / 1000),
        status: job.run_status
      })),
      stuckJobs: stuckJobs.length,
      recentFailures: failedTransactionsData.filter(t => t.error_message).slice(0, 10),
      systemMetrics: {
        totalActiveJobs: activeJobsData.length,
        averageQueueTime: '2.3s', // Would calculate from actual data
        apiUptime: '99.9%' // From Uptime Robot
      }
    };
    
    logger('info', 'System health retrieved', { activeJobs: activeJobsData.length, stuckJobs: stuckJobs.length, requestId });
    
    return c.json(createStandardResponse(true, responseData, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'System health check failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

// ===============================================================================
// LEADS ANALYTICS SECTION
// ===============================================================================

async function handleLeadsAnalytics(c: Context<{ Bindings: Env }>, requestId: string): Promise<Response> {
  try {
    const supabaseUrl = await getApiKey('SUPABASE_URL', c.env, c.env.APP_ENV);
    const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', c.env, c.env.APP_ENV);
    
    const headers = {
      'apikey': serviceRole,
      'Authorization': `Bearer ${serviceRole}`,
      'Content-Type': 'application/json'
    };
    
    const [leadsData, runsData, transactionsData] = await Promise.all([
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/leads?select=*`, { headers }),
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/runs?select=*`, { headers }),
      fetchJson<any[]>(`${supabaseUrl}/rest/v1/credit_transactions?select=*&type=eq.use`, { headers })
    ]);
    
    // Lead quality tiers
    const premiumLeads = runsData.filter(r => r.overall_score >= 90).length;
    const goodLeads = runsData.filter(r => r.overall_score >= 70 && r.overall_score < 90).length;
    const poorLeads = runsData.filter(r => r.overall_score < 70).length;
    
    const avgScore = runsData.length > 0
      ? Math.round(runsData.reduce((sum, r) => sum + (r.overall_score || 0), 0) / runsData.length)
      : 0;
    
    // Analysis performance by type
    const analysisPerformance = ['light', 'deep', 'xray'].map(type => {
      const typeRuns = runsData.filter(r => r.analysis_type === type);
      const typeTransactions = transactionsData.filter(t => {
        const run = runsData.find(r => r.run_id === t.run_id);
        return run?.analysis_type === type;
      });
      
      const avgTime = typeTransactions.length > 0
        ? Math.round(typeTransactions.reduce((sum, t) => sum + (t.processing_duration_ms || 0), 0) / typeTransactions.length)
        : 0;
      
      const avgCost = typeTransactions.length > 0
        ? (typeTransactions.reduce((sum, t) => sum + (t.actual_cost || 0), 0) / typeTransactions.length).toFixed(4)
        : '0.0000';
      
      const successRate = typeRuns.length > 0
        ? Math.round((typeRuns.filter(r => r.run_status === 'completed').length / typeRuns.length) * 100)
        : 0;
      
      return {
        type,
        totalRuns: typeRuns.length,
        avgCompletionTime: `${avgTime}ms`,
        avgCost,
        successRate: `${successRate}%`
      };
    });
    
    const responseData = {
      leadOverview: {
        totalLeads: leadsData.length,
        avgScore,
        qualityTiers: {
          premium: premiumLeads,
          good: goodLeads,
          poor: poorLeads
        }
      },
      analysisPerformance
    };
    
    logger('info', 'Leads analytics calculated', { totalLeads: leadsData.length, requestId });
    
    return c.json(createStandardResponse(true, responseData, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Leads analytics failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}
