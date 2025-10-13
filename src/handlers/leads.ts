import type { Context } from 'hono';
import type { Env } from '../types/interfaces.js';
import { getDashboardLeads } from '../services/database.js';
import { authenticateRequest } from '../utils/auth.js';
import { createStandardResponse, generateRequestId, logger } from '../utils/logger.js';

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
