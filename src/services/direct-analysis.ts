import { UniversalAIAdapter } from './universal-ai-adapter.js';
import { buildSpeedLightAnalysisPrompt, buildDeepAnalysisPrompt, buildXRayAnalysisPrompt, getLightAnalysisJsonSchema, getDeepAnalysisJsonSchema, getXRayAnalysisJsonSchema } from './prompts.js';
import { logger } from '../utils/logger.js';
import type { ProfileData } from '../types/interfaces.js';

export interface DirectAnalysisResult {
  analysisData: any;
  costDetails: { 
    actual_cost: number;
    tokens_in: number;
    tokens_out: number;
    model_used: string;
    block_type: string;
    processing_duration_ms: number;
  };
}

export class DirectAnalysisExecutor {
  private aiAdapter: UniversalAIAdapter;
  private env: any;
  private requestId: string;

  constructor(env: any, requestId: string) {
    this.env = env;
    this.requestId = requestId;
    this.aiAdapter = new UniversalAIAdapter(env, requestId);
  }

  private parseJsonResponse(content: string, analysisType: string): any {
  try {
    // Clean the response first
    let cleanContent = content.trim();
    
    // Fix common JSON issues from GPT responses
    cleanContent = cleanContent
      .replace(/,\s*"confidence"/, ', "confidence"')  // Fix spacing
      .replace(/,\s*}/, '}')                          // Remove trailing commas
      .replace(/,$/, '');                             // Remove trailing comma at end
    
    logger('info', 'Parsing JSON response', {
      original_length: content.length,
      cleaned_length: cleanContent.length,
      analysis_type: analysisType,
      first_50_chars: cleanContent.substring(0, 50),
      requestId: this.requestId
    });
    
    const parsed = JSON.parse(cleanContent);
    
    // Fix summary punctuation if needed
    if (parsed.summary && !parsed.summary.match(/[.!?]$/)) {
      parsed.summary = parsed.summary.replace(/,$/, '.').trim();
      logger('info', 'Fixed summary punctuation', {
        original: content.match(/"summary":\s*"([^"]+)"/)?.[1],
        fixed: parsed.summary,
        requestId: this.requestId
      });
    }
    
    return parsed;
    
  } catch (parseError: any) {
    logger('error', 'JSON parse failed, attempting recovery', {
      error: parseError.message,
      content_preview: content.substring(0, 200),
      analysis_type: analysisType,
      requestId: this.requestId
    });
    
    // Fallback: try to extract values manually
    const scoreMatch = content.match(/"score":\s*(\d+)/);
    const summaryMatch = content.match(/"summary":\s*"([^"]+)"/);
    const confidenceMatch = content.match(/"confidence":\s*([\d.]+)/);
    
    const fallbackResult = {
      score: scoreMatch ? parseInt(scoreMatch[1]) : 0,
      summary: summaryMatch ? summaryMatch[1].replace(/,$/, '.') : 'Analysis completed',
      confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
      niche_fit: scoreMatch ? parseInt(scoreMatch[1]) : 0,
      engagement_score: scoreMatch ? Math.max(20, parseInt(scoreMatch[1]) - 10) : 0,
      confidence_level: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5
    };
    
    logger('info', 'JSON recovery successful', {
      extracted_values: fallbackResult,
      requestId: this.requestId
    });
    
    return fallbackResult;
  }
}

  async executeLight(profile: ProfileData, business: any): Promise<DirectAnalysisResult> {
    const startTime = Date.now();
    
    logger('info', 'Direct light analysis starting', { 
      username: profile.username, 
      requestId: this.requestId 
    });

const response = await this.aiAdapter.executeRequest({
  model_name: 'gpt-5-mini',
system_prompt: 'Rate lead fit honestly. If profile audience does not match business target, reflect this in low score and clear explanation. Return JSON only.',
  user_prompt: buildSpeedLightAnalysisPrompt(profile, business),
  max_tokens: 1000,
  json_schema: getLightAnalysisJsonSchema(),
  response_format: 'json',
  temperature: 0.0,
  analysis_type: 'light'
});

    const processingTime = Date.now() - startTime;
    const analysisData = this.parseJsonResponse(response.content, 'light analysis');

    return {
      analysisData,
      costDetails: {
        actual_cost: response.usage.total_cost,
        tokens_in: response.usage.input_tokens,
        tokens_out: response.usage.output_tokens,
        model_used: response.model_used,
        block_type: 'direct_light',
        processing_duration_ms: processingTime
      }
    };
  }

async executeDeep(profile: ProfileData, business: any): Promise<DirectAnalysisResult> {
  const startTime = Date.now();
  
  logger('info', 'Optimized deep analysis starting', { 
    username: profile.username, 
    requestId: this.requestId 
  });

  // Execute 2 parallel calls instead of 3 (merged core+strategy)
  const [coreStrategyAnalysis, outreachAnalysis] = await Promise.all([
    this.executeCoreStrategyMerged(profile, business),
    this.executeOutreachGeneration(profile, business)
  ]);

const analysisData = {
  score: coreStrategyAnalysis.score,
  engagement_score: coreStrategyAnalysis.engagement_score,
  niche_fit: coreStrategyAnalysis.niche_fit,
  quick_summary: coreStrategyAnalysis.quick_summary,
  confidence_level: coreStrategyAnalysis.confidence_level,
  
  deep_payload: {
    deep_summary: coreStrategyAnalysis.deep_summary,
    selling_points: coreStrategyAnalysis.selling_points,
    reasons: coreStrategyAnalysis.reasons,
    audience_insights: coreStrategyAnalysis.audience_insights,
    outreach_message: outreachAnalysis.outreach_message,
    engagement_breakdown: coreStrategyAnalysis.engagement_breakdown
  },
  
  // NEW: Store raw pre-processed data
  pre_processed_metrics: (profile as any).preProcessed || null
};

  const processingTime = Date.now() - startTime;
  const totalCost = coreStrategyAnalysis.cost + outreachAnalysis.cost;
  const totalTokensIn = coreStrategyAnalysis.tokens_in + outreachAnalysis.tokens_in;
  const totalTokensOut = coreStrategyAnalysis.tokens_out + outreachAnalysis.tokens_out;

  logger('info', 'Optimized deep analysis completed', {
    username: profile.username,
    processing_time: processingTime,
    total_cost: totalCost,
    optimization: '2-call merged strategy'
  });

  return {
    analysisData,
    costDetails: {
      actual_cost: totalCost,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      model_used: 'gpt-5-mini-merged',
      block_type: 'optimized_deep',
      processing_duration_ms: processingTime
    }
  };
}

private async executeCoreStrategyMerged(profile: ProfileData, business: any): Promise<any> {
  const response = await this.aiAdapter.executeRequest({
    model_name: 'gpt-5-mini',
    system_prompt: 'Score influencer partnership potential AND generate comprehensive strategy in single response. Combine scoring with strategic analysis efficiently.',
user_prompt: buildDeepAnalysisPrompt(profile, business),
    max_tokens: 3500,
    json_schema: {
      name: 'MergedCoreStrategy',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // Core scoring
          score: { type: 'integer', minimum: 0, maximum: 100 },
          engagement_score: { type: 'integer', minimum: 0, maximum: 100 },
          niche_fit: { type: 'integer', minimum: 0, maximum: 100 },
          quick_summary: { type: 'string', maxLength: 800 },
          confidence_level: { type: 'number', minimum: 0, maximum: 1 },
          engagement_breakdown: {
            type: 'object',
            additionalProperties: false,
            properties: {
              avg_likes: { type: 'integer' },
              avg_comments: { type: 'integer' },
              engagement_rate: { type: 'number' }
            },
            required: ['avg_likes', 'avg_comments', 'engagement_rate']
          },
          // Strategy analysis
          deep_summary: { type: 'string', maxLength: 1500 },
          selling_points: { 
            type: 'array', 
            items: { type: 'string' }, 
            minItems: 3, 
            maxItems: 6 
          },
          reasons: { 
            type: 'array', 
            items: { type: 'string' }, 
            minItems: 3, 
            maxItems: 8 
          },
          audience_insights: { type: 'string', maxLength: 600 }
        },
        required: ['score', 'engagement_score', 'niche_fit', 'quick_summary', 'confidence_level', 'engagement_breakdown', 'deep_summary', 'selling_points', 'reasons', 'audience_insights']
      }
    },
    response_format: 'json',
    temperature: 0.3,
    analysis_type: 'deep_merged'
  });

  const result = this.parseJsonResponse(response.content, 'light analysis');
  return {
    ...result,
    cost: response.usage.total_cost,
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens
  };
}

  private async executeOutreachGeneration(profile: ProfileData, business: any): Promise<any> {
  const response = await this.aiAdapter.executeRequest({
    model_name: 'gpt-5-mini',
    system_prompt: 'Write personalized outreach message for influencer partnership. Be specific and compelling.',
    user_prompt: `Outreach to @${profile.username}: ${profile.followersCount} followers, "${profile.bio}". ${business.business_name} offers ${business.business_one_liner}. Write personalized message.`,
    max_tokens: 1500,
    json_schema: {
      name: 'OutreachMessage',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outreach_message: { type: 'string', maxLength: 1000 }
        },
        required: ['outreach_message']
      }
    },
    response_format: 'json',
    temperature: 0.6,
    analysis_type: 'deep_outreach'
  });

  const result = this.parseJsonResponse(response.content, 'light analysis');
  return {
    ...result,
    cost: response.usage.total_cost,
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens
  };
}

  async executeXRay(profile: ProfileData, business: any): Promise<DirectAnalysisResult> {
  const startTime = Date.now();
  
  logger('info', 'Optimized X-Ray analysis starting', { 
    username: profile.username, 
    requestId: this.requestId 
  });

  // Execute 2 parallel calls: psychological profiling + commercial intelligence
  const [psychProfileAnalysis, commercialAnalysis] = await Promise.all([
    this.executePsychographicProfiling(profile, business),
    this.executeCommercialIntelligence(profile, business)
  ]);


// Generate comprehensive deep summary for X-Ray
const deepSummary = `Demographics: ${psychProfileAnalysis.demographics}. Psychographics: ${psychProfileAnalysis.psychographics}. Pain Points: ${psychProfileAnalysis.pain_points.join('; ')}. Dreams: ${psychProfileAnalysis.dreams_desires.join('; ')}. Commercial Profile: ${commercialAnalysis.budget_tier} budget tier, ${commercialAnalysis.decision_role} decision role, ${commercialAnalysis.buying_stage} buying stage. Persuasion Strategy: Use ${commercialAnalysis.primary_angle} angle with ${commercialAnalysis.hook_style} hook style. Communication: ${commercialAnalysis.communication_style} tone.`;

// Merge results into X-Ray structure
const analysisData = {
  score: psychProfileAnalysis.score,
  engagement_score: psychProfileAnalysis.engagement_score,
  niche_fit: psychProfileAnalysis.niche_fit,
  quick_summary: psychProfileAnalysis.quick_summary,
  confidence_level: psychProfileAnalysis.confidence_level,
  
  xray_payload: {
    deep_summary: psychProfileAnalysis.deep_summary,  // Use AI-generated deep_summary
    copywriter_profile: {
      demographics: psychProfileAnalysis.demographics,
      psychographics: psychProfileAnalysis.psychographics,
      pain_points: psychProfileAnalysis.pain_points,
      dreams_desires: psychProfileAnalysis.dreams_desires
    },
    commercial_intelligence: {
      budget_tier: commercialAnalysis.budget_tier,
      decision_role: commercialAnalysis.decision_role,
      buying_stage: commercialAnalysis.buying_stage,
      objections: commercialAnalysis.objections
    },
    persuasion_strategy: {
      primary_angle: commercialAnalysis.primary_angle,
      hook_style: commercialAnalysis.hook_style,
      proof_elements: commercialAnalysis.proof_elements,
      communication_style: commercialAnalysis.communication_style
    },
    pre_processed_metrics: (profile as any).preProcessed || null
  }
};

  const processingTime = Date.now() - startTime;
  const totalCost = psychProfileAnalysis.cost + commercialAnalysis.cost;
  const totalTokensIn = psychProfileAnalysis.tokens_in + commercialAnalysis.tokens_in;
  const totalTokensOut = psychProfileAnalysis.tokens_out + commercialAnalysis.tokens_out;

  logger('info', 'Optimized X-Ray analysis completed', {
    username: profile.username,
    processing_time: processingTime,
    total_cost: totalCost,
    optimization: '2-call parallel X-Ray'
  });

  return {
    analysisData,
    costDetails: {
      actual_cost: totalCost,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      model_used: 'gpt-5-mini',
      block_type: 'optimized_xray',
      processing_duration_ms: processingTime
    }
  };
}

private async executePsychographicProfiling(profile: ProfileData, business: any): Promise<any> {
  const response = await this.aiAdapter.executeRequest({
    model_name: 'gpt-5-mini', // Downgrade from GPT-5 for cost efficiency
    system_prompt: 'Extract psychological profile from Instagram data. Focus on demographics, psychographics, pain points, and aspirations. Be precise and evidence-based.',
user_prompt: buildXRayAnalysisPrompt(profile, business),
    max_tokens: 2000,
    json_schema: {
      name: 'PsychographicProfile',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          // Core scoring
          score: { type: 'integer', minimum: 0, maximum: 100 },
          engagement_score: { type: 'integer', minimum: 0, maximum: 100 },
          niche_fit: { type: 'integer', minimum: 0, maximum: 100 },
          quick_summary: { type: 'string', maxLength: 800 },
          confidence_level: { type: 'number', minimum: 0, maximum: 1 },
          deep_summary: { type: 'string', maxLength: 2000 },
          // Psychographic data
          demographics: { type: 'string', maxLength: 300 },
          psychographics: { type: 'string', maxLength: 400 },
          pain_points: { 
            type: 'array', 
            items: { type: 'string' }, 
            minItems: 2, 
            maxItems: 6 
          },
          dreams_desires: { 
            type: 'array', 
            items: { type: 'string' }, 
            minItems: 2, 
            maxItems: 6 
          }
        },
        required: ['score', 'engagement_score', 'niche_fit', 'quick_summary', 'confidence_level', 'deep_summary', 'demographics', 'psychographics', 'pain_points', 'dreams_desires']
      }
    },
    response_format: 'json',
    temperature: 0.4,
    analysis_type: 'xray_psych'
  });

  const result = this.parseJsonResponse(response.content, 'light analysis');
  return {
    ...result,
    cost: response.usage.total_cost,
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens
  };
}

private async executeCommercialIntelligence(profile: ProfileData, business: any): Promise<any> {
  const response = await this.aiAdapter.executeRequest({
    model_name: 'gpt-5-mini',
    system_prompt: 'Analyze audience-business alignment realistically. If the audience is NOT solution-aware for the business offering, explicitly state this. Do not force fit. Assess actual buying readiness, budget capacity, and commercial viability.',
    user_prompt: `Reality Check: Does @${profile.username}'s audience align with ${business.business_name}?

Profile Bio: "${profile.bio}"
Audience Size: ${profile.followersCount}
Your Business: ${business.business_one_liner || business.target_audience}

CRITICAL: Be honest about commercial viability. If this audience is:
- Platform users (not buyers of external products)
- Creators (not B2B buyers)
- Consumers (not decision-makers)
- Awareness stage (not solution-aware)

Then reflect that in your assessment. Don't force-fit them into a buyer journey if they're not buyers.

Determine:
- Budget tier (be realistic about their actual spending capacity)
- Decision role (are they even decision-makers for this category?)
- Buying stage (are they ACTUALLY aware of solutions like this, or still at problem-unaware?)
- Real objections (not SaaS objections if they're not SaaS buyers)
- Communication approach (based on where they ACTUALLY are)`,
    max_tokens: 2000,
    json_schema: {
      name: 'CommercialIntelligence',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
budget_tier: { 
  type: 'string',
  enum: ['no-budget-prosumer', 'low-budget', 'mid-market', 'premium', 'luxury', 'not-applicable']
},
buying_stage: { 
  type: 'string',
  enum: ['completely-unaware', 'problem-unaware', 'problem-aware', 'solution-aware', 'product-aware', 'ready-to-buy', 'not-in-market']
},
decision_role: { 
  type: 'string',
  enum: ['not-a-buyer', 'end-user', 'influencer', 'gatekeeper', 'decision-maker', 'economic-buyer']
},
          objections: { 
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 5
          },
          primary_angle: { 
            type: 'string',
            enum: ['transformation', 'status', 'convenience', 'fear-of-missing-out', 'social-proof', 'authority']
          },
          hook_style: { 
            type: 'string',
            enum: ['problem-agitation', 'curiosity-gap', 'social-proof', 'authority-positioning', 'story-based']
          },
          proof_elements: { 
            type: 'array',
            items: { type: 'string' },
            minItems: 3,
            maxItems: 7
          },
          communication_style: { 
            type: 'string',
            enum: ['casual-friendly', 'professional', 'authoritative', 'empathetic', 'energetic']
          }
        },
        required: ['budget_tier', 'decision_role', 'buying_stage', 'objections', 'primary_angle', 'hook_style', 'proof_elements', 'communication_style']
      }
    },
    response_format: 'json',
    temperature: 0.3,
    analysis_type: 'xray_commercial'
  });

  const result = this.parseJsonResponse(response.content, 'light analysis');
  return {
    ...result,
    cost: response.usage.total_cost,
    tokens_in: response.usage.input_tokens,
    tokens_out: response.usage.output_tokens
  };
}
}
