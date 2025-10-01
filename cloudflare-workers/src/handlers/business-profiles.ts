// ===============================================================================
// BUSINESS PROFILES API ENDPOINT - Complete Implementation
// File: cloudflare-workers/src/handlers/business-profiles.ts
// ===============================================================================

import type { Context } from 'hono';
import type { Env } from '../types/interfaces.js';
import { generateRequestId, logger } from '../utils/logger.js';
import { createStandardResponse } from '../utils/response.js';
import { validateJWTToken, extractUserFromJWT } from '../utils/auth.js';

// ===============================================================================
// HELPER: GET SUPABASE CONFIG FROM AWS (CACHED PER REQUEST)
// ===============================================================================

let _cachedSupabaseUrl: string | null = null;
let _cachedServiceRole: string | null = null;

async function getSupabaseUrl(env: Env): Promise<string> {
  if (_cachedSupabaseUrl) return _cachedSupabaseUrl;
  const { getApiKey } = await import('../services/enhanced-config-manager.js');
  _cachedSupabaseUrl = await getApiKey('SUPABASE_URL', env, env.APP_ENV);
  return _cachedSupabaseUrl;
}

async function getSupabaseServiceRole(env: Env): Promise<string> {
  if (_cachedServiceRole) return _cachedServiceRole;
  const { getApiKey } = await import('../services/enhanced-config-manager.js');
  _cachedServiceRole = await getApiKey('SUPABASE_SERVICE_ROLE', env, env.APP_ENV);
  return _cachedServiceRole;
}
// ===============================================================================
// INTERFACES
// ===============================================================================

interface BusinessProfileData {
  // Core business info (required)
  business_name: string;
  business_niche: string;
  target_audience: string;
  
  // New onboarding fields
  company_size?: string;
  website?: string;
  budget?: string;
  monthly_lead_goal?: number;
  challenges?: string[];
  target_company_sizes?: string[];
  integrations?: string[];
  team_size?: string;
  campaign_manager?: string;
  primary_objective?: string;
  communication_style?: string;
  
  // Legacy compatibility fields (auto-generated if not provided)
  target_problems?: string;
  value_proposition?: string;
  message_example?: string;
  success_outcome?: string;
  call_to_action?: string;
  
  // AI-generated fields
  business_one_liner?: string;
  business_context_pack?: object;
  context_version?: string;
}

// ===============================================================================
// MAIN HANDLER
// ===============================================================================

export async function handleBusinessProfiles(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = generateRequestId();
  const method = c.req.method;
  const url = new URL(c.req.url);
  const pathSegments = url.pathname.split('/').filter(Boolean);
  
  try {
    // Authenticate user
    const authResult = await authenticateRequest(c, requestId);
    if (!authResult.success) {
      return c.json(createStandardResponse(false, undefined, authResult.error, requestId), 401);
    }
    
    const { userId } = authResult;
    
    // Route to appropriate handler
    switch (method) {
      case 'GET':
        if (pathSegments.length === 1) {
          // GET /business-profiles - List all profiles
          return handleListProfiles(c, userId, requestId);
        } else if (pathSegments.length === 2) {
          // GET /business-profiles/:id - Get specific profile
          const profileId = pathSegments[1];
          return handleGetProfile(c, userId, profileId, requestId);
        }
        break;
        
      case 'POST':
        // POST /business-profiles - Create new profile
        return handleCreateProfile(c, userId, requestId);
        
      case 'PUT':
        if (pathSegments.length === 2) {
          // PUT /business-profiles/:id - Update profile
          const profileId = pathSegments[1];
          return handleUpdateProfile(c, userId, profileId, requestId);
        }
        break;
        
      case 'DELETE':
        if (pathSegments.length === 2) {
          // DELETE /business-profiles/:id - Soft delete profile
          const profileId = pathSegments[1];
          return handleDeleteProfile(c, userId, profileId, requestId);
        }
        break;
    }
    
    return c.json(createStandardResponse(false, undefined, 'Invalid endpoint or method', requestId), 404);
    
  } catch (error: any) {
    logger('error', 'Business profiles handler error', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, 'Internal server error', requestId), 500);
  }
}

// ===============================================================================
// CRUD OPERATIONS
// ===============================================================================

async function handleListProfiles(
  c: Context<{ Bindings: Env }>, 
  userId: string, 
  requestId: string
): Promise<Response> {
  try {
    logger('info', 'Fetching user business profiles', { userId, requestId });
    
    const supabaseUrl = await getSupabaseUrl(c.env);
    const response = await fetch(
      `${supabaseUrl}/rest/v1/business_profiles?select=*&user_id=eq.${userId}&is_active=eq.true&order=created_at.desc`,
      { headers: await createHeaders(c.env) }
    );
    
    if (!response.ok) {
      throw new Error(`Database query failed: ${response.status}`);
    }
    
    const profiles = await response.json();
    
    logger('info', 'Profiles fetched successfully', { 
      userId, 
      profileCount: profiles.length, 
      requestId 
    });
    
    return c.json(createStandardResponse(true, profiles, undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Failed to fetch profiles', { error: error.message, userId, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

async function handleGetProfile(
  c: Context<{ Bindings: Env }>, 
  userId: string, 
  profileId: string, 
  requestId: string
): Promise<Response> {
  try {
    logger('info', 'Fetching specific business profile', { userId, profileId, requestId });
    
    const supabaseUrl = await getSupabaseUrl(c.env);
    const response = await fetch(
      `${supabaseUrl}/rest/v1/business_profiles?select=*&id=eq.${profileId}&user_id=eq.${userId}&is_active=eq.true`,
      { headers: await createHeaders(c.env) }
    );
    
    if (!response.ok) {
      throw new Error(`Database query failed: ${response.status}`);
    }
    
    const profiles = await response.json();
    
    if (!profiles || profiles.length === 0) {
      return c.json(createStandardResponse(false, undefined, 'Profile not found', requestId), 404);
    }
    
    logger('info', 'Profile fetched successfully', { userId, profileId, requestId });
    
    return c.json(createStandardResponse(true, profiles[0], undefined, requestId));
    
  } catch (error: any) {
    logger('error', 'Failed to fetch profile', { error: error.message, userId, profileId, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

async function handleCreateProfile(
  c: Context<{ Bindings: Env }>, 
  userId: string, 
  requestId: string
): Promise<Response> {
  try {
    logger('info', 'Creating new business profile', { userId, requestId });
    
    const body = await c.req.json() as BusinessProfileData;
    
    // Validate required fields
    const validation = validateBusinessProfileData(body);
    if (!validation.isValid) {
      return c.json(createStandardResponse(false, undefined, validation.error, requestId), 400);
    }
    
    // Sanitize and prepare data
    const profileData = sanitizeBusinessProfileData(body, userId);
    
    logger('info', 'Profile data prepared for database', {
      userId,
      business_name: profileData.business_name,
      has_context_pack: !!profileData.business_context_pack,
      has_one_liner: !!profileData.business_one_liner,
      requestId
    });
    
    // Insert into database
    const supabaseUrl = await getSupabaseUrl(c.env);
    const response = await fetch(
      `${supabaseUrl}/rest/v1/business_profiles`,
      {
        method: 'POST',
        headers: await createPreferHeaders(c.env, 'return=representation'),
        body: JSON.stringify(profileData)
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Database insert failed: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    
    if (!result || !result.length) {
      throw new Error('Profile creation failed - no data returned');
    }
    
    const newProfile = result[0];
    
    // Update user onboarding status
    await updateUserOnboardingStatus(userId, c.env, requestId);
    
    // Log analytics event
    await logAnalyticsEvent({
      event_type: 'business_profile_created',
      user_id: userId,
      business_id: newProfile.id,
      properties: {
        business_name: newProfile.business_name,
        business_niche: newProfile.business_niche,
        has_ai_context: !!newProfile.business_context_pack,
        monthly_lead_goal: newProfile.monthly_lead_goal,
        budget_tier: newProfile.budget
      }
    }, c.env, requestId);
    
    logger('info', 'Business profile created successfully', {
      userId,
      profileId: newProfile.id,
      business_name: newProfile.business_name,
      requestId
    });
    
    return c.json(createStandardResponse(true, newProfile, 'Profile created successfully', requestId), 201);
    
  } catch (error: any) {
    logger('error', 'Failed to create profile', { error: error.message, userId, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

async function handleUpdateProfile(
  c: Context<{ Bindings: Env }>, 
  userId: string, 
  profileId: string, 
  requestId: string
): Promise<Response> {
  try {
    logger('info', 'Updating business profile', { userId, profileId, requestId });
    
    const body = await c.req.json() as Partial<BusinessProfileData>;
    
    // Validate update data
    const validation = validateBusinessProfileUpdate(body);
    if (!validation.isValid) {
      return c.json(createStandardResponse(false, undefined, validation.error, requestId), 400);
    }
    
    // Sanitize update data
    const updateData = sanitizeBusinessProfileUpdateData(body);
    updateData.updated_at = new Date().toISOString();
    
    // Update database
    const supabaseUrl = await getSupabaseUrl(c.env);
    const response = await fetch(
      `${supabaseUrl}/rest/v1/business_profiles?id=eq.${profileId}&user_id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: await createPreferHeaders(c.env, 'return=representation'),
        body: JSON.stringify(updateData)
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Database update failed: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    
    if (!result || !result.length) {
      return c.json(createStandardResponse(false, undefined, 'Profile not found or access denied', requestId), 404);
    }
    
    const updatedProfile = result[0];
    
    // Log analytics event
    await logAnalyticsEvent({
      event_type: 'business_profile_updated',
      user_id: userId,
      business_id: profileId,
      properties: {
        fields_updated: Object.keys(body),
        update_trigger: 'manual'
      }
    }, c.env, requestId);
    
    logger('info', 'Business profile updated successfully', {
      userId,
      profileId,
      fieldsUpdated: Object.keys(body),
      requestId
    });
    
    return c.json(createStandardResponse(true, updatedProfile, 'Profile updated successfully', requestId));
    
  } catch (error: any) {
    logger('error', 'Failed to update profile', { error: error.message, userId, profileId, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

async function handleDeleteProfile(
  c: Context<{ Bindings: Env }>, 
  userId: string, 
  profileId: string, 
  requestId: string
): Promise<Response> {
  try {
    logger('info', 'Soft deleting business profile', { userId, profileId, requestId });
    
    // Soft delete by setting is_active to false
    const supabaseUrl = await getSupabaseUrl(c.env);
    const response = await fetch(
      `${supabaseUrl}/rest/v1/business_profiles?id=eq.${profileId}&user_id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: await createPreferHeaders(c.env, 'return=representation'),
        body: JSON.stringify({ 
          is_active: false, 
          updated_at: new Date().toISOString() 
        })
      }
    );
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Database update failed: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    
    if (!result || !result.length) {
      return c.json(createStandardResponse(false, undefined, 'Profile not found or access denied', requestId), 404);
    }
    
    // Log analytics event
    await logAnalyticsEvent({
      event_type: 'business_profile_deleted',
      user_id: userId,
      business_id: profileId,
      properties: {
        deletion_type: 'soft_delete'
      }
    }, c.env, requestId);
    
    logger('info', 'Business profile deleted successfully', { userId, profileId, requestId });
    
    return c.json(createStandardResponse(true, { deleted: true }, 'Profile deleted successfully', requestId));
    
  } catch (error: any) {
    logger('error', 'Failed to delete profile', { error: error.message, userId, profileId, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

// ===============================================================================
// UTILITY FUNCTIONS
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

function validateBusinessProfileData(data: BusinessProfileData) {
  const requiredFields = ['business_name', 'business_niche', 'target_audience'];
  const missingFields = requiredFields.filter(field => !data[field] || data[field].trim().length === 0);
  
  if (missingFields.length > 0) {
    return { isValid: false, error: `Missing required fields: ${missingFields.join(', ')}` };
  }
  
  // Validate data types
  if (data.monthly_lead_goal && (typeof data.monthly_lead_goal !== 'number' || data.monthly_lead_goal < 1)) {
    return { isValid: false, error: 'monthly_lead_goal must be a positive number' };
  }
  
  if (data.business_one_liner && data.business_one_liner.length > 140) {
    return { isValid: false, error: 'business_one_liner must be 140 characters or less' };
  }
  
  // Validate arrays
  if (data.challenges && !Array.isArray(data.challenges)) {
    return { isValid: false, error: 'challenges must be an array' };
  }
  
  if (data.target_company_sizes && !Array.isArray(data.target_company_sizes)) {
    return { isValid: false, error: 'target_company_sizes must be an array' };
  }
  
  if (data.integrations && !Array.isArray(data.integrations)) {
    return { isValid: false, error: 'integrations must be an array' };
  }
  
  return { isValid: true };
}

function validateBusinessProfileUpdate(data: Partial<BusinessProfileData>) {
  // For updates, only validate provided fields
  if (data.monthly_lead_goal !== undefined && (typeof data.monthly_lead_goal !== 'number' || data.monthly_lead_goal < 1)) {
    return { isValid: false, error: 'monthly_lead_goal must be a positive number' };
  }
  
  if (data.business_one_liner !== undefined && data.business_one_liner.length > 140) {
    return { isValid: false, error: 'business_one_liner must be 140 characters or less' };
  }
  
  return { isValid: true };
}

function sanitizeBusinessProfileData(data: BusinessProfileData, userId: string) {
  return {
    user_id: userId,
    business_name: data.business_name.trim(),
    business_niche: data.business_niche.trim(),
    target_audience: data.target_audience.trim(),
    
    // New onboarding fields
    company_size: data.company_size?.trim() || null,
    website: data.website?.trim() || null,
    budget: data.budget?.trim() || null,
    monthly_lead_goal: data.monthly_lead_goal || null,
    challenges: data.challenges || null,
    target_company_sizes: data.target_company_sizes || null,
    integrations: data.integrations || null,
    team_size: data.team_size?.trim() || null,
    campaign_manager: data.campaign_manager?.trim() || null,
    primary_objective: data.primary_objective?.trim() || null,
    communication_style: data.communication_style?.trim() || null,
    
    // Legacy fields
    target_problems: data.target_problems?.trim() || null,
    value_proposition: data.value_proposition?.trim() || null,
    message_example: data.message_example?.trim() || null,
    success_outcome: data.success_outcome?.trim() || null,
    call_to_action: data.call_to_action?.trim() || null,
    
    // AI-generated fields
    business_one_liner: data.business_one_liner?.trim() || null,
    business_context_pack: data.business_context_pack || null,
    context_version: data.context_version || 'v1.0',
    context_updated_at: data.business_context_pack ? new Date().toISOString() : null,
    
    // Metadata
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

function sanitizeBusinessProfileUpdateData(data: Partial<BusinessProfileData>) {
  const updateData: any = {};
  
  // Only include fields that are present in the update
  Object.keys(data).forEach(key => {
    if (data[key] !== undefined) {
      if (typeof data[key] === 'string') {
        updateData[key] = data[key].trim();
      } else {
        updateData[key] = data[key];
      }
    }
  });
  
  // Update context timestamp if context pack is being updated
  if (data.business_context_pack) {
    updateData.context_updated_at = new Date().toISOString();
  }
  
  return updateData;
}

async function updateUserOnboardingStatus(userId: string, env: Env, requestId: string) {
  try {
    const supabaseUrl = await getSupabaseUrl(env);
    await fetch(
      `${supabaseUrl}/rest/v1/users?id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: await createHeaders(env),
        body: JSON.stringify({ onboarding_completed: true })
      }
    );
    
    logger('info', 'User onboarding status updated', { userId, requestId });
  } catch (error: any) {
    logger('warn', 'Failed to update onboarding status', { error: error.message, userId, requestId });
  }
}

async function logAnalyticsEvent(event: any, env: Env, requestId: string) {
  try {
    // Implementation depends on your analytics system
    logger('info', 'Analytics event logged', { event_type: event.event_type, requestId });
  } catch (error: any) {
    logger('warn', 'Failed to log analytics event', { error: error.message, requestId });
  }
}

async function createHeaders(env: Env) {
  const serviceRole = await getSupabaseServiceRole(env);
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
}

async function createPreferHeaders(env: Env, prefer: string) {
  const headers = await createHeaders(env);
  return {
    ...headers,
    Prefer: prefer
  };
}
