import type { Env } from '../types/interfaces.js';
import { fetchJson } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';
import { getApiKey } from './enhanced-config-manager.js';

// ===============================================================================
// SHARED UTILITIES
// ===============================================================================

async function createHeaders(env: Env): Promise<Record<string, string>> {
  const serviceRole = await getApiKey('SUPABASE_SERVICE_ROLE', env, env.APP_ENV);
  
  return {
    apikey: serviceRole,
    Authorization: `Bearer ${serviceRole}`,
    'Content-Type': 'application/json'
  };
}

async function createPreferHeaders(env: Env, prefer: string): Promise<Record<string, string>> {
  const headers = await createHeaders(env);
  return {
    ...headers,
    Prefer: prefer
  };
}

async function getSupabaseUrl(env: Env): Promise<string> {
  return await getApiKey('SUPABASE_URL', env, env.APP_ENV);
}

// ===============================================================================
// LEADS TABLE OPERATIONS
// ===============================================================================

export async function upsertLead(
  leadData: any,
  env: Env
): Promise<string> {
  try {
    logger('info', 'Upserting lead record', { 
      username: leadData.username,
      business_id: leadData.business_id
    });

    logger('info', 'Upserting lead record', { 
      username: leadData.username,
      business_id: leadData.business_id,
      raw_following_data: {
        followingCount: leadData.followingCount,
        following_count: leadData.following_count,
        postsCount: leadData.postsCount,
        posts_count: leadData.posts_count,
        followersCount: leadData.followersCount,
        followers_count: leadData.followers_count
      }
    });

    const cleanLeadData = {
      user_id: leadData.user_id,
      business_id: leadData.business_id,
      username: leadData.username,
      display_name: leadData.full_name || leadData.displayName || null,
      profile_picture_url: leadData.profile_pic_url || leadData.profilePicUrl || null,
      bio_text: leadData.bio || null,
      external_website_url: leadData.external_url || leadData.externalUrl || null,
      
      follower_count: parseInt(leadData.followersCount || leadData.follower_count || '0'),
      following_count: parseInt(leadData.followsCount || leadData.followingCount || leadData.following_count || '0'),
      post_count: parseInt(leadData.postsCount || leadData.post_count || '0'),
      
      is_verified_account: leadData.is_verified || leadData.isVerified || false,
      is_private_account: leadData.is_private || leadData.isPrivate || false,
      is_business_account: leadData.is_business_account || leadData.isBusinessAccount || false,
      
      platform_type: 'instagram',
      profile_url: leadData.profile_url || `https://instagram.com/${leadData.username}`,
      
      last_updated_at: new Date().toISOString()
    };

    logger('info', 'Clean lead data before upsert', {
      username: cleanLeadData.username,
      follower_count: cleanLeadData.follower_count,
      following_count: cleanLeadData.following_count,
      post_count: cleanLeadData.post_count,
      original_fields_available: {
        followingCount: !!leadData.followingCount,
        following_count: !!leadData.following_count,
        postsCount: !!leadData.postsCount,
        posts_count: !!leadData.posts_count
      }
    });

    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createPreferHeaders(env, 'return=representation,resolution=merge-duplicates');
    const upsertQuery = `${supabaseUrl}/rest/v1/leads?on_conflict=user_id,username,business_id`;

    const leadResponse = await fetch(upsertQuery, {
      method: 'POST',
      headers,
      body: JSON.stringify(cleanLeadData)
    });

    if (!leadResponse.ok) {
      const errorText = await leadResponse.text();
      throw new Error(`Failed to upsert lead: ${leadResponse.status} - ${errorText}`);
    }

    const leadResult = await leadResponse.json();
    if (!leadResult || !leadResult.length) {
      throw new Error('Failed to create/update lead record - no data returned');
    }

    const lead_id = leadResult[0].lead_id;
    logger('info', 'Lead upserted successfully', { lead_id, username: leadData.username });
    
    return lead_id;

  } catch (error: any) {
    logger('error', 'upsertLead failed', { error: error.message });
    throw new Error(`Lead upsert failed: ${error.message}`);
  }
}

// ===============================================================================
// RUNS TABLE OPERATIONS
// ===============================================================================

export async function insertAnalysisRun(
  lead_id: string,
  user_id: string,
  business_id: string,
  analysisType: string,
  analysisResult: any,
  env: Env
): Promise<string> {
  try {
    logger('info', 'Inserting analysis run', { 
      lead_id, 
      analysisType,
      score: analysisResult.score
    });

    const runData = {
      lead_id,
      user_id,
      business_id,
      analysis_type: analysisType,
      analysis_version: '1.0',
      
      overall_score: Math.round(parseFloat(analysisResult.score) || 0),
      niche_fit_score: Math.round(parseFloat(analysisResult.niche_fit) || 0),
      engagement_score: Math.round(parseFloat(analysisResult.engagement_score) || 0),
      
      summary_text: analysisResult.summary || 
                   analysisResult.quick_summary || 
                   analysisResult.summary_text ||
                   `${analysisType} analysis completed - Score: ${Math.round(parseFloat(analysisResult.score) || 0)}/100`,
      confidence_level: parseFloat(analysisResult.confidence_level) || 
                       parseFloat(analysisResult.confidence) || 
                       (analysisType === 'light' ? 0.6 : analysisType === 'deep' ? 0.75 : 0.85),
      
      run_status: 'completed',
      ai_model_used: analysisResult.pipeline_metadata?.workflow_used || 'pipeline_system',
      analysis_completed_at: new Date().toISOString()
    };

    logger('info', 'Run data prepared for database insert', {
      lead_id,
      analysis_type: analysisType,
      summary_text: runData.summary_text,
      confidence_level: runData.confidence_level,
      summary_length: runData.summary_text?.length,
      confidence_is_number: typeof runData.confidence_level === 'number'
    });

    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createPreferHeaders(env, 'return=representation');
    
    const runResponse = await fetch(`${supabaseUrl}/rest/v1/runs`, {
      method: 'POST',
      headers,
      body: JSON.stringify(runData)
    });

    if (!runResponse.ok) {
      const errorText = await runResponse.text();
      throw new Error(`Failed to insert run: ${runResponse.status} - ${errorText}`);
    }

    const runResult = await runResponse.json();
    if (!runResult || !runResult.length) {
      throw new Error('Failed to create run record - no data returned');
    }

    const run_id = runResult[0].run_id;
    logger('info', 'Analysis run inserted successfully', { run_id, analysisType });
    
    return run_id;

  } catch (error: any) {
    logger('error', 'insertAnalysisRun failed', { error: error.message });
    throw new Error(`Run insert failed: ${error.message}`);
  }
}

// ===============================================================================
// PAYLOADS TABLE OPERATIONS
// ===============================================================================

export async function insertAnalysisPayload(
  run_id: string,
  lead_id: string,
  user_id: string,
  business_id: string,
  analysisType: string,
  analysisData: any,
  env: Env
): Promise<string> {
  try {
    logger('info', 'Inserting analysis payload', { 
      run_id, 
      analysisType,
      dataKeys: Object.keys(analysisData || {}).length
    });

    let structuredPayload;
    
    switch (analysisType) {        
      case 'deep':
        const deepData = analysisData.deep_payload || analysisData;
        const engagementData = deepData.engagement_breakdown || {};
        
        structuredPayload = {
          deep_summary: deepData.deep_summary || null,
          selling_points: deepData.selling_points || [],
          outreach_message: deepData.outreach_message || null,
          engagement_breakdown: {
            avg_likes: parseInt(engagementData.avg_likes) || parseInt(analysisData.avg_likes) || 0,
            avg_comments: parseInt(engagementData.avg_comments) || parseInt(analysisData.avg_comments) || 0,
            engagement_rate: parseFloat(engagementData.engagement_rate) || parseFloat(analysisData.engagement_rate) || 0
          },
          latest_posts: deepData.latest_posts || null,
          audience_insights: deepData.audience_insights || analysisData.engagement_insights || null,
          reasons: deepData.reasons || []
        };
        break;
        
      case 'xray':
        const xrayData = analysisData.xray_payload || analysisData;
        structuredPayload = {
          copywriter_profile: xrayData.copywriter_profile || {},
          commercial_intelligence: xrayData.commercial_intelligence || {},
          persuasion_strategy: xrayData.persuasion_strategy || {}
        };
        break;
        
      default:
        structuredPayload = analysisData;
    }

    const payloadData = {
      run_id,
      lead_id,
      user_id,
      business_id,
      analysis_type: analysisType,
      analysis_data: structuredPayload,
      data_size_bytes: JSON.stringify(structuredPayload).length
    };

    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createPreferHeaders(env, 'return=representation');
    
    const payloadResponse = await fetch(`${supabaseUrl}/rest/v1/payloads`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payloadData)
    });

    if (!payloadResponse.ok) {
      const errorText = await payloadResponse.text();
      throw new Error(`Failed to insert payload: ${payloadResponse.status} - ${errorText}`);
    }

    const payloadResult = await payloadResponse.json();
    if (!payloadResult || !payloadResult.length) {
      throw new Error('Failed to create payload record - no data returned');
    }

    const payload_id = payloadResult[0].payload_id;
    logger('info', 'Analysis payload inserted successfully', { payload_id, analysisType });
    
    return payload_id;

  } catch (error: any) {
    logger('error', 'insertAnalysisPayload failed', { error: error.message });
    throw new Error(`Payload insert failed: ${error.message}`);
  }
}

// ===============================================================================
// MAIN SAVE FUNCTION
// ===============================================================================

export async function saveCompleteAnalysis(
  leadData: any,
  analysisData: any,
  analysisType: string,
  env: Env
): Promise<{ run_id: string; lead_id: string }> {
  try {
    logger('info', 'Starting complete analysis save', { 
      username: leadData.username,
      analysisType
    });

    const lead_id = await upsertLead(leadData, env);

    const run_id = await insertAnalysisRun(
      lead_id,
      leadData.user_id,
      leadData.business_id,
      analysisType,
      analysisData,
      env
    );

    if (analysisData && (analysisType === 'deep' || analysisType === 'xray')) {
      await insertAnalysisPayload(
        run_id,
        lead_id,
        leadData.user_id,
        leadData.business_id,
        analysisType,
        analysisData,
        env
      );
    }

    logger('info', 'Complete analysis save successful', { 
      lead_id, 
      run_id, 
      analysisType 
    });
    
    return { run_id, lead_id };

  } catch (error: any) {
    logger('error', 'saveCompleteAnalysis failed', { error: error.message });
    throw new Error(`Complete analysis save failed: ${error.message}`);
  }
}

// ===============================================================================
// QUERY FUNCTIONS FOR DASHBOARD
// ===============================================================================

export async function getDashboardLeads(
  user_id: string,
  business_id: string,
  env: Env,
  limit: number = 50
): Promise<any[]> {
  try {
    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createHeaders(env);
    
    const query = `${supabaseUrl}/rest/v1/leads?select=lead_id,username,display_name,profile_picture_url,follower_count,is_verified_account,runs(run_id,analysis_type,overall_score,niche_fit_score,engagement_score,summary_text,confidence_level,created_at)&user_id=eq.${user_id}&business_id=eq.${business_id}&order=runs.created_at.desc&limit=${limit}`;

    const response = await fetch(query, { headers });

    if (!response.ok) {
      throw new Error(`Dashboard query failed: ${response.status}`);
    }

    const results = await response.json();
    logger('info', 'Dashboard leads retrieved', { count: results.length });
    
    return results;

  } catch (error: any) {
    logger('error', 'getDashboardLeads failed', { error: error.message });
    throw new Error(`Dashboard query failed: ${error.message}`);
  }
}

export async function getAnalysisDetails(
  run_id: string,
  user_id: string,
  env: Env
): Promise<any> {
  try {
    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createHeaders(env);
    
    const query = `${supabaseUrl}/rest/v1/runs?select=*,leads(*),payloads(analysis_data)&run_id=eq.${run_id}&leads.user_id=eq.${user_id}`;

    const response = await fetch(query, { headers });

    if (!response.ok) {
      throw new Error(`Analysis details query failed: ${response.status}`);
    }

    const results = await response.json();
    if (!results.length) {
      throw new Error('Analysis not found or access denied');
    }

    logger('info', 'Analysis details retrieved', { run_id });
    return results[0];

  } catch (error: any) {
    logger('error', 'getAnalysisDetails failed', { error: error.message });
    throw new Error(`Analysis details query failed: ${error.message}`);
  }
}

// ===============================================================================
// CREDIT SYSTEM
// ===============================================================================

export async function updateCreditsAndTransaction(
  user_id: string,
  cost: number,
  analysisType: string,
  run_id: string,
  costDetails: {
    actual_cost: number;
    tokens_in: number;
    tokens_out: number;
    model_used: string;
    block_type: string;
    processing_duration_ms?: number;
    blocks_used?: string[];
  },
  env: Env,
  lead_id?: string
): Promise<void> {
  try {
    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createHeaders(env);

    const userResponse = await fetch(
      `${supabaseUrl}/rest/v1/users?select=credits&id=eq.${user_id}`,
      { headers }
    );

    if (!userResponse.ok) {
      throw new Error(`Failed to fetch user: ${userResponse.status}`);
    }

    const users = await userResponse.json();
    if (!users.length) {
      throw new Error('User not found');
    }

    const currentCredits = users[0].credits || 0;
    const newBalance = Math.max(0, currentCredits - cost);

    await fetchJson(
      `${supabaseUrl}/rest/v1/users?id=eq.${user_id}`,
      {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ credits: newBalance })
      },
      10000
    );

    const transactionData = {
      user_id,
      amount: -cost,
      type: 'use',
      description: `${analysisType} analysis`,
      run_id: run_id,
      actual_cost: costDetails.actual_cost,
      tokens_in: costDetails.tokens_in,
      tokens_out: costDetails.tokens_out,
      model_used: costDetails.model_used,
      block_type: costDetails.block_type,
      processing_duration_ms: costDetails.processing_duration_ms || null,
      blocks_used: costDetails.blocks_used?.join('+') || null,
    };

    logger('info', 'Transaction data prepared', {
      user_id,
      run_id,
      lead_id,
      amount: transactionData.amount,
      description: transactionData.description,
      has_lead_id: !!lead_id
    });

    await fetchJson(
      `${supabaseUrl}/rest/v1/credit_transactions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(transactionData)
      },
      10000
    );

    logger('info', 'Credits and transaction updated successfully', { 
      user_id, 
      cost, 
      newBalance
    });

  } catch (error: any) {
    logger('error', 'updateCreditsAndTransaction error:', error.message);
    throw new Error(`Failed to update credits: ${error.message}`);
  }
}

export async function fetchUserAndCredits(user_id: string, env: Env): Promise<any> {
  try {
    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createHeaders(env);
    
    const response = await fetch(
      `${supabaseUrl}/rest/v1/users?select=*&id=eq.${user_id}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error(`User fetch failed: ${response.status}`);
    }

    const users = await response.json();
    if (!users.length) {
      return { isValid: false, error: 'User not found' };
    }

    const user = users[0];
    return {
      isValid: true,
      credits: user.credits || 0,
      userId: user.id
    };

  } catch (error: any) {
    logger('error', 'fetchUserAndCredits failed', { error: error.message });
    return { isValid: false, error: error.message };
  }
}

export async function fetchBusinessProfile(business_id: string, user_id: string, env: Env): Promise<any> {
  try {
    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createHeaders(env);
    
    const response = await fetch(
      `${supabaseUrl}/rest/v1/business_profiles?select=*,business_one_liner,business_context_pack,context_version,context_updated_at&id=eq.${business_id}&user_id=eq.${user_id}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error(`Business profile fetch failed: ${response.status}`);
    }

    const profiles = await response.json();
    if (!profiles.length) {
      throw new Error('Business profile not found or access denied');
    }

    return profiles[0];

  } catch (error: any) {
    logger('error', 'fetchBusinessProfile failed', { error: error.message });
    throw new Error(`Business profile fetch failed: ${error.message}`);
  }
}

export async function getLeadIdFromRun(run_id: string, env: Env): Promise<string> {
  try {
    const supabaseUrl = await getSupabaseUrl(env);
    const headers = await createHeaders(env);
    
    const response = await fetch(
      `${supabaseUrl}/rest/v1/runs?select=lead_id&run_id=eq.${run_id}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch run: ${response.status}`);
    }

    const runs = await response.json();
    if (!runs.length) {
      throw new Error('Run not found');
    }

    return runs[0].lead_id;

  } catch (error: any) {
    logger('error', 'getLeadIdFromRun failed', { error: error.message, run_id });
    throw new Error(`Failed to get lead_id from run: ${error.message}`);
  }
}
