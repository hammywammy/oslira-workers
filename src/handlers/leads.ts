// ===============================================================================
// LEADS HANDLER - Dashboard Leads Endpoint
// File: cloudflare-workers/src/handlers/leads.ts
// ===============================================================================

import type { Context } from 'hono';
import type { Env } from '../types/interfaces.js';
import { getDashboardLeads } from '../services/database.js';
import { extractUserFromJWT } from '../utils/auth.js';
import { generateRequestId, logger } from '../utils/logger.js';

// ===============================================================================
// AUTHENTICATION HELPER (copied from business-profiles.ts)
// ===============================================================================

async function authenticateRequest(c: Context<{ Bindings: Env }>, requestId: string) {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { success: false, error: 'No valid authorization header' };
    }
    
    const token = authHeader.substring(7);
    const userResult = await extractUserFromJWT(token, c.env, requestId);
    
    if (!userResult.isValid) {
      return { success: false, error: userResult.error };
    }
    
    return { success: true, userId: userResult.userId };
    
  } catch (error: any) {
    logger('error', 'Authentication failed', { error: error.message, requestId });
    return { success: false, error: 'Authentication failed' };
  }
}

// ===============================================================================
// DASHBOARD LEADS ENDPOINT
// ===============================================================================

export async function handleGetDashboardLeads(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    // 1. Authenticate user
    const authResult = await authenticateRequest(c, requestId);
    if (!authResult.success) {
      return c.json({ success: false, error: 'Unauthorized' }, 401);
    }
    
    // 2. Get parameters
    const businessId = c.req.query('business_id');
    if (!businessId) {
      return c.json({ success: false, error: 'business_id required' }, 400);
    }
    
    const limit = parseInt(c.req.query('limit') || '50');
    
    // 3. Fetch leads using EXISTING function
    logger('info', 'Fetching dashboard leads', { 
      userId: authResult.userId, 
      businessId, 
      limit 
    });
    
    const leads = await getDashboardLeads(
      authResult.userId,
      businessId,
      c.env,
      limit
    );
    
    // 4. Return data
    return c.json({ 
      success: true, 
      data: leads,
      requestId 
    });
    
  } catch (error: any) {
    logger('error', 'Dashboard leads failed', { error: error.message, requestId });
    return c.json({ 
      success: false, 
      error: error.message,
      requestId 
    }, 500);
  }
}
