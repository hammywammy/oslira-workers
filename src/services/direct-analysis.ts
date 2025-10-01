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
  system_prompt: 'Rate leads fast. Return JSON only.',
  user_prompt: buildSpeedLightAnalysisPrompt(profile, business),
  max_tokens: 1500,
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

  // Merge results
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
    }
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
    user_prompt: `Partnership Analysis: @${profile.username} (${profile.followersCount}) + ${business.business_name}
    
Bio: "${profile.bio}"
Business: ${business.business_one_liner || business.target_audience}

Score 0-100 for niche fit, engagement, overall match. Generate partnership strategy, selling points, audience insights, and reasons for collaboration.`,
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
          quick_summary: { type: 'string', maxLength: 200 },
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

  // Merge results into X-Ray structure
  const analysisData = {
    score: psychProfileAnalysis.score,
    engagement_score: psychProfileAnalysis.engagement_score,
    niche_fit: psychProfileAnalysis.niche_fit,
    quick_summary: psychProfileAnalysis.quick_summary,
    confidence_level: psychProfileAnalysis.confidence_level,
    
    xray_payload: {
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
      }
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
    user_prompt: `Psychographic Analysis: @${profile.username} (${profile.followersCount})

Bio: "${profile.bio}"
Content Sample: ${profile.latestPosts?.slice(0, 3).map(p => `"${p.caption?.slice(0, 60)}..."`).join(' | ') || 'No posts'}

Extract observable demographics, psychographics, pain points, and dreams/desires for ${business.target_audience} business context.`,
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
          quick_summary: { type: 'string', maxLength: 200 },
          confidence_level: { type: 'number', minimum: 0, maximum: 1 },
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
        required: ['score', 'engagement_score', 'niche_fit', 'quick_summary', 'confidence_level', 'demographics', 'psychographics', 'pain_points', 'dreams_desires']
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
    system_prompt: 'Analyze commercial behavior and persuasion strategy from Instagram profile. Focus on buying patterns, objections, and optimal persuasion approaches.',
    user_prompt: `Commercial Intelligence: @${profile.username} (${profile.followersCount})

Bio: "${profile.bio}"
Follower Tier: ${profile.followersCount > 100000 ? 'macro' : profile.followersCount > 10000 ? 'mid' : 'micro'}
Business Context: ${business.business_one_liner || business.target_audience}

Determine budget tier, decision role, buying stage, objections, and optimal persuasion strategy.`,
    max_tokens: 1500,
    json_schema: {
      name: 'CommercialIntelligence',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          budget_tier: { 
            type: 'string',
            enum: ['low-budget', 'mid-market', 'premium', 'luxury']
          },
          decision_role: { 
            type: 'string',
            enum: ['primary', 'influencer', 'gatekeeper', 'researcher']
          },
          buying_stage: { 
            type: 'string',
            enum: ['unaware', 'problem-aware', 'solution-aware', 'product-aware', 'ready-to-buy']
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
