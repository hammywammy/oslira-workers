import { UniversalAIAdapter } from './universal-ai-adapter.js';
import { buildSpeedLightAnalysisPrompt, buildDeepAnalysisPrompt, buildXRayAnalysisPrompt, getLightAnalysisJsonSchema, getDeepAnalysisJsonSchema, getXRayAnalysisJsonSchema } from './prompts.js';
import { logger } from '../utils/logger.js';
import type { ProfileData } from '../types/interfaces.js';
import { OutreachGenerator } from './outreach-generator.js';

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

  // ============================================================================
  // LIGHT ANALYSIS
  // ============================================================================

  async executeLight(profile: ProfileData, business: any): Promise<DirectAnalysisResult> {
    const startTime = Date.now();
    
    logger('info', '⚡ Light analysis starting', {
      username: profile.username,
      requestId: this.requestId
    });

    try {
      const response = await this.aiAdapter.executeRequest({
        model_name: 'gpt-5-mini',
        system_prompt: `Quick partnership scoring. Score 0-100 based on audience-business fit. 
If profile audience does not match business target, reflect this in low score and clear explanation. Return JSON only.`,
        user_prompt: buildSpeedLightAnalysisPrompt(profile, business),
        max_tokens: 1000,
        json_schema: getLightAnalysisJsonSchema(),
        response_format: 'json',
        temperature: 0.0,
        analysis_type: 'light'
      });

      const processingTime = Date.now() - startTime;
      const analysisData = this.parseJsonResponse(response.content, 'light analysis');

      logger('info', '✅ Light analysis complete', {
        score: analysisData.score,
        processingTime,
        requestId: this.requestId
      });

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
    } catch (error: any) {
      logger('error', '❌ Light analysis failed', {
        error: error.message,
        stack: error.stack,
        requestId: this.requestId
      });
      throw error;
    }
  }

  // ============================================================================
  // DEEP ANALYSIS
  // ============================================================================

// ===============================================================================
// UPDATED METHODS FOR src/services/direct-analysis.ts
// Replace your existing executeDeep() and executeXRay() with these versions
// ===============================================================================

async executeDeep(profile: ProfileData, business: any): Promise<DirectAnalysisResult> {
  const startTime = Date.now();
  
  logger('info', '🔬 Deep analysis starting', { 
    username: profile.username, 
    requestId: this.requestId 
  });

  try {
    // PHASE 1: Core strategy + parallel workers (outreach + personality)
    logger('info', '📊 Starting core strategy analysis', {
      username: profile.username,
      requestId: this.requestId
    });

    const coreStrategyAnalysis = await this.executeCoreStrategyMerged(profile, business);

    logger('info', '✅ Core strategy complete, starting parallel workers', {
      strategyScore: coreStrategyAnalysis.score,
      strategyCost: coreStrategyAnalysis.cost,
      requestId: this.requestId
    });

    // PHASE 2: Run outreach + personality in parallel
    const [outreachAnalysis, personalityAnalysis] = await Promise.all([
      this.executeOutreachGeneration(profile, business, {
        key_insights: coreStrategyAnalysis.deep_summary || 'Deep partnership analysis'
      }),
      this.executePersonalityAnalysis(profile)
    ]);

    logger('info', '✅ Parallel workers complete', {
      outreachLength: outreachAnalysis.outreach_message?.length,
      discProfile: personalityAnalysis.disc_profile,
      outreachCost: outreachAnalysis.cost,
      personalityCost: personalityAnalysis.cost,
      requestId: this.requestId
    });

    const preProcessedMetrics = (profile as any).preProcessed ? {
      engagement: (profile as any).preProcessed.engagement || null,
      content: (profile as any).preProcessed.content || null,
      posting: (profile as any).preProcessed.posting || null,
      summary: (profile as any).preProcessed.summary || null
    } : null;

    const analysisData = {
      score: coreStrategyAnalysis.score,
      engagement_score: coreStrategyAnalysis.engagement_score,
      niche_fit: coreStrategyAnalysis.niche_fit,
      quick_summary: coreStrategyAnalysis.quick_summary,
      confidence_level: coreStrategyAnalysis.confidence_level,
      pre_processed_metrics: preProcessedMetrics,
      
      deep_payload: {
        deep_summary: coreStrategyAnalysis.deep_summary,
        selling_points: coreStrategyAnalysis.selling_points,
        reasons: coreStrategyAnalysis.reasons,
        audience_insights: coreStrategyAnalysis.audience_insights,
        outreach_message: outreachAnalysis.outreach_message,
        engagement_breakdown: coreStrategyAnalysis.engagement_breakdown,
        pre_processed_metrics: preProcessedMetrics,
        personality_profile: personalityAnalysis  // NEW
      }
    };

    const processingTime = Date.now() - startTime;
    const totalCost = coreStrategyAnalysis.cost + outreachAnalysis.cost + personalityAnalysis.cost;
    const totalTokensIn = coreStrategyAnalysis.tokens_in + outreachAnalysis.tokens_in + personalityAnalysis.tokens_in;
    const totalTokensOut = coreStrategyAnalysis.tokens_out + outreachAnalysis.tokens_out + personalityAnalysis.tokens_out;

    logger('info', '✅ Deep analysis complete', {
      username: profile.username,
      score: analysisData.score,
      discProfile: personalityAnalysis.disc_profile,
      processingTime,
      totalCost,
      requestId: this.requestId
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
  } catch (error: any) {
    logger('error', '❌ Deep analysis failed', {
      error: error.message,
      stack: error.stack,
      requestId: this.requestId
    });
    throw error;
  }
}

// ============================================================================
// X-RAY ANALYSIS
// ============================================================================

async executeXRay(profile: ProfileData, business: any): Promise<DirectAnalysisResult> {
  const startTime = Date.now();
  
  // PRE-FLIGHT VALIDATION
  logger('info', '🔍 X-Ray pre-flight validation', {
    hasProfile: !!profile,
    hasBusiness: !!business,
    username: profile?.username,
    businessName: business?.business_name,
    profileKeys: profile ? Object.keys(profile).slice(0, 10) : [],
    businessKeys: business ? Object.keys(business) : [],
    requestId: this.requestId
  });

  if (!profile) {
    throw new Error('❌ X-Ray failed: Profile is null/undefined');
  }

  if (!business) {
    throw new Error('❌ X-Ray failed: Business is null/undefined');
  }

  if (!profile.username) {
    throw new Error('❌ X-Ray failed: Profile missing username');
  }

  if (!business.business_name) {
    throw new Error('❌ X-Ray failed: Business missing business_name');
  }

  logger('info', '✅ X-Ray validation passed, starting analysis', { 
    username: profile.username,
    businessName: business.business_name,
    requestId: this.requestId 
  });

  try {
    // PHASE 1: Psychographic + Commercial Intelligence (Parallel)
    logger('info', '📊 Phase 1: Starting psychographic + commercial analysis', {
      username: profile.username,
      requestId: this.requestId
    });

    const [psychProfileAnalysis, commercialAnalysis] = await Promise.all([
      this.executePsychographicProfiling(profile, business),
      this.executeCommercialIntelligence(profile, business)
    ]);

    logger('info', '✅ Phase 1 complete', {
      psychScore: psychProfileAnalysis.score,
      psychNicheFit: psychProfileAnalysis.niche_fit,
      commercialBudget: commercialAnalysis.budget_tier,
      commercialRole: commercialAnalysis.decision_role,
      psychCost: psychProfileAnalysis.cost,
      commercialCost: commercialAnalysis.cost,
      requestId: this.requestId
    });

    // PHASE 2: Outreach + Personality (Parallel)
    logger('info', '📝 Phase 2: Starting outreach + personality analysis', {
      score: psychProfileAnalysis.score,
      nicheFit: psychProfileAnalysis.niche_fit,
      psychographics: psychProfileAnalysis.psychographics?.substring(0, 50),
      budgetTier: commercialAnalysis.budget_tier,
      requestId: this.requestId
    });

    const [outreachAnalysis, personalityAnalysis] = await Promise.all([
      this.executeOutreachGeneration(profile, business, {
        score: psychProfileAnalysis.score || 0,
        niche_fit: psychProfileAnalysis.niche_fit || 0,
        audience_type: 'Creator-focused',
        key_insights: `${psychProfileAnalysis.psychographics || 'Unknown psychographics'}. Budget: ${commercialAnalysis.budget_tier || 'unknown'}`
      }),
      this.executePersonalityAnalysis(profile)
    ]);

    logger('info', '✅ Phase 2 complete', {
      messageLength: outreachAnalysis.outreach_message?.length,
      discProfile: personalityAnalysis.disc_profile,
      outreachCost: outreachAnalysis.cost,
      personalityCost: personalityAnalysis.cost,
      requestId: this.requestId
    });

    // BUILD FINAL X-RAY STRUCTURE
    const painPointsStr = psychProfileAnalysis.pain_points?.join('; ') || 'Not determined';
    const dreamsStr = psychProfileAnalysis.dreams_desires?.join('; ') || 'Not determined';

    const deepSummary = `Demographics: ${psychProfileAnalysis.demographics || 'Unknown'}. Psychographics: ${psychProfileAnalysis.psychographics || 'Unknown'}. Pain Points: ${painPointsStr}. Dreams: ${dreamsStr}. Commercial Profile: ${commercialAnalysis.budget_tier || 'unknown'} budget tier, ${commercialAnalysis.decision_role || 'unknown'} decision role, ${commercialAnalysis.buying_stage || 'unknown'} buying stage. Persuasion Strategy: Use ${commercialAnalysis.primary_angle || 'unknown'} angle with ${commercialAnalysis.hook_style || 'unknown'} hook style. Communication: ${commercialAnalysis.communication_style || 'unknown'} tone.`;

    const preProcessedMetrics = (profile as any).preProcessed ? {
      engagement: (profile as any).preProcessed.engagement || null,
      content: (profile as any).preProcessed.content || null,
      posting: (profile as any).preProcessed.posting || null,
      summary: (profile as any).preProcessed.summary || null
    } : null;

    const analysisData = {
      score: psychProfileAnalysis.score,
      engagement_score: psychProfileAnalysis.engagement_score,
      niche_fit: psychProfileAnalysis.niche_fit,
      quick_summary: psychProfileAnalysis.quick_summary,
      confidence_level: psychProfileAnalysis.confidence_level,
      pre_processed_metrics: preProcessedMetrics,
      
      xray_payload: {
        deep_summary: deepSummary,
        copywriter_profile: {
          demographics: psychProfileAnalysis.demographics || 'Unknown',
          psychographics: psychProfileAnalysis.psychographics || 'Unknown',
          pain_points: psychProfileAnalysis.pain_points || ['Not determined'],
          dreams_desires: psychProfileAnalysis.dreams_desires || ['Not determined']
        },
        commercial_intelligence: {
          budget_tier: commercialAnalysis.budget_tier || 'unknown',
          decision_role: commercialAnalysis.decision_role || 'unknown',
          buying_stage: commercialAnalysis.buying_stage || 'unknown',
          objections: commercialAnalysis.objections || ['Not determined']
        },
        persuasion_strategy: {
          primary_angle: commercialAnalysis.primary_angle || 'unknown',
          hook_style: commercialAnalysis.hook_style || 'unknown',
          proof_elements: commercialAnalysis.proof_elements || ['Not determined'],
          communication_style: commercialAnalysis.communication_style || 'unknown'
        },
        outreach_message: outreachAnalysis.outreach_message || 'Outreach generation failed',
        pre_processed_metrics: preProcessedMetrics,
        personality_profile: personalityAnalysis  // NEW
      }
    };

    const processingTime = Date.now() - startTime;
    const totalCost = psychProfileAnalysis.cost + commercialAnalysis.cost + outreachAnalysis.cost + personalityAnalysis.cost;
    const totalTokensIn = psychProfileAnalysis.tokens_in + commercialAnalysis.tokens_in + outreachAnalysis.tokens_in + personalityAnalysis.tokens_in;
    const totalTokensOut = psychProfileAnalysis.tokens_out + commercialAnalysis.tokens_out + outreachAnalysis.tokens_out + personalityAnalysis.tokens_out;

    logger('info', '✅ X-Ray analysis complete', {
      username: profile.username,
      score: analysisData.score,
      discProfile: personalityAnalysis.disc_profile,
      processingTime,
      totalCost,
      phasesExecuted: 2,
      requestId: this.requestId
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

  } catch (error: any) {
    logger('error', '❌ X-Ray analysis failed', {
      error: error.message,
      stack: error.stack,
      username: profile?.username,
      requestId: this.requestId
    });
    throw error;
  }
}

  // ============================================================================
  // PRIVATE ANALYSIS METHODS
  // ============================================================================

  private async executeCoreStrategyMerged(profile: ProfileData, business: any): Promise<any> {
    logger('info', '🎯 Core strategy analysis starting', {
      username: profile.username,
      requestId: this.requestId
    });

    try {
      const response = await this.aiAdapter.executeRequest({
        model_name: 'gpt-5-mini',
        system_prompt: 'Score influencer partnership potential AND generate comprehensive strategy in single response. Be realistic about fit.',
        user_prompt: buildDeepAnalysisPrompt(profile, business),
        max_tokens: 3000,
        json_schema: getDeepAnalysisJsonSchema(),
        response_format: 'json',
        temperature: 0.4,
        analysis_type: 'deep_merged'
      });

      logger('info', '✅ Core strategy AI response received', {
        contentLength: response.content?.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        requestId: this.requestId
      });

      const result = this.parseJsonResponse(response.content, 'deep analysis');
      
      logger('info', '✅ Core strategy parsed successfully', {
        score: result.score,
        nicheFit: result.niche_fit,
        hasSellingPoints: !!result.deep_payload?.selling_points,
        requestId: this.requestId
      });

      return {
        ...result,
        ...result.deep_payload,
        cost: response.usage.total_cost,
        tokens_in: response.usage.input_tokens,
        tokens_out: response.usage.output_tokens
      };
    } catch (error: any) {
      logger('error', '❌ Core strategy failed', {
        error: error.message,
        stack: error.stack,
        requestId: this.requestId
      });
      throw error;
    }
  }

  private async executePsychographicProfiling(profile: ProfileData, business: any): Promise<any> {
    logger('info', '🧠 Psychographic profiling starting', {
      username: profile.username,
      businessName: business.business_name,
      requestId: this.requestId
    });

    try {
      const response = await this.aiAdapter.executeRequest({
        model_name: 'gpt-5-mini',
        system_prompt: `Extract audience psychological profile. 
Return ONLY the required JSON fields: score, engagement_score, niche_fit, quick_summary, confidence_level, deep_summary (text summary, NOT nested JSON), demographics, psychographics, pain_points, dreams_desires. Follow the schema exactly. Do not nest additional JSON structures.`,
        user_prompt: buildXRayAnalysisPrompt(profile, business),
        max_tokens: 3000,
        json_schema: {
          name: 'PsychographicProfile',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              score: { type: 'integer', minimum: 0, maximum: 100 },
              engagement_score: { type: 'integer', minimum: 0, maximum: 100 },
              niche_fit: { type: 'integer', minimum: 0, maximum: 100 },
              quick_summary: { type: 'string', maxLength: 800 },
              confidence_level: { type: 'number', minimum: 0, maximum: 1 },
              deep_summary: { type: 'string', maxLength: 2000 },
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

      logger('info', '✅ Psychographic AI response received', {
        contentLength: response.content?.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        requestId: this.requestId
      });

      const result = this.parseJsonResponse(response.content, 'psychographic analysis');
      
      logger('info', '✅ Psychographic parsed successfully', {
        score: result.score,
        nicheFit: result.niche_fit,
        hasPainPoints: !!result.pain_points,
        hasDreams: !!result.dreams_desires,
        painPointsCount: result.pain_points?.length,
        dreamsCount: result.dreams_desires?.length,
        requestId: this.requestId
      });

      return {
        ...result,
        cost: response.usage.total_cost,
        tokens_in: response.usage.input_tokens,
        tokens_out: response.usage.output_tokens
      };
    } catch (error: any) {
      logger('error', '❌ Psychographic profiling failed', {
        error: error.message,
        stack: error.stack,
        username: profile.username,
        requestId: this.requestId
      });
      throw error;
    }
  }

  private async executeCommercialIntelligence(profile: ProfileData, business: any): Promise<any> {
    logger('info', '💼 Commercial intelligence starting', {
      username: profile.username,
      businessName: business.business_name,
      requestId: this.requestId
    });

    try {
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

Return JSON with: budget_tier, decision_role, buying_stage, objections, primary_angle, hook_style, proof_elements, communication_style.`,
        max_tokens: 2000,
        json_schema: {
          name: 'CommercialIntelligence',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              budget_tier: { type: 'string', enum: ['low', 'medium', 'high', 'enterprise', 'unknown'] },
              decision_role: { type: 'string', enum: ['decision_maker', 'influencer', 'end_user', 'unknown'] },
              buying_stage: { type: 'string', enum: ['unaware', 'problem_aware', 'solution_aware', 'product_aware', 'purchase_ready', 'unknown'] },
              objections: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
              primary_angle: { type: 'string' },
              hook_style: { type: 'string' },
              proof_elements: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5 },
              communication_style: { type: 'string' }
            },
            required: ['budget_tier', 'decision_role', 'buying_stage', 'objections', 'primary_angle', 'hook_style', 'proof_elements', 'communication_style']
          }
        },
        response_format: 'json',
        temperature: 0.4,
        analysis_type: 'xray_commercial'
      });

      logger('info', '✅ Commercial AI response received', {
        contentLength: response.content?.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        requestId: this.requestId
      });

      const result = this.parseJsonResponse(response.content, 'commercial analysis');
      
      logger('info', '✅ Commercial parsed successfully', {
        budgetTier: result.budget_tier,
        decisionRole: result.decision_role,
        buyingStage: result.buying_stage,
        requestId: this.requestId
      });

      return {
        ...result,
        cost: response.usage.total_cost,
        tokens_in: response.usage.input_tokens,
        tokens_out: response.usage.output_tokens
      };
    } catch (error: any) {
      logger('error', '❌ Commercial intelligence failed', {
        error: error.message,
        stack: error.stack,
        requestId: this.requestId
      });
      throw error;
    }
  }

  private async executeOutreachGeneration(profile: ProfileData, business: any, context?: any): Promise<any> {
    logger('info', '📧 Initiating outreach generation', {
      username: profile.username,
      hasContext: !!context,
      contextScore: context?.score,
      requestId: this.requestId
    });

    try {
      const outreachGen = new OutreachGenerator(this.env, this.requestId);
      const result = await outreachGen.generate(profile, business, context);
      
      logger('info', '✅ Outreach generation complete', {
        messageLength: result.outreach_message?.length,
        cost: result.cost,
        requestId: this.requestId
      });
      
      return result;
    } catch (error: any) {
      logger('error', '❌ Outreach generation failed', {
        error: error.message,
        stack: error.stack,
        requestId: this.requestId
      });
      throw error;
    }
  }

  private async executePersonalityAnalysis(profile: ProfileData): Promise<any> {
  const startTime = Date.now();
  
  // Pre-flight check
  const hasContent = profile.latestPosts && profile.latestPosts.length >= 5;
  const hasBio = profile.bio && profile.bio.length > 20;
  const hasPreProcessed = !!(profile as any).preProcessed;
  
  if (!hasContent && !hasBio) {
    logger('warn', '⚠️ Insufficient data for personality', {
      username: profile.username,
      postsCount: profile.latestPosts?.length || 0,
      bioLength: profile.bio?.length || 0
    });
    
    return {
      disc_profile: 'Insufficient data',
      behavior_patterns: ['Not enough content to analyze'],
      communication_style: 'Unknown - insufficient data',
      motivation_drivers: ['Unable to determine'],
      content_authenticity: 'insufficient_data',
      data_confidence: 'low',
      cost: 0,
      tokens_in: 0,
      tokens_out: 0
    };
  }
  
  logger('info', '🧠 Personality analysis starting', {
    username: profile.username,
    hasPreProcessed,
    postsCount: profile.latestPosts?.length || 0,
    requestId: this.requestId
  });
  
  try {
    const response = await this.aiAdapter.executeRequest({
      model_name: 'gpt-5-nano',
      system_prompt: 'DISC personality expert analyzing social media. Base analysis ONLY on observable behavior. NO business context. Be honest about AI vs human content.',
      user_prompt: buildPersonalityAnalysisPrompt(profile),
      max_tokens: 600,
      json_schema: getPersonalityAnalysisJsonSchema(),
      response_format: 'json',
      temperature: 0.3,
      analysis_type: 'personality'
    });
    
    logger('info', '✅ Personality complete', {
      username: profile.username,
      disc: response.content?.disc_profile,
      authenticity: response.content?.content_authenticity,
      cost: response.usage.total_cost,
      requestId: this.requestId
    });
    
    const result = this.parseJsonResponse(response.content, 'personality');
    
    return {
      ...result,
      cost: response.usage.total_cost,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens
    };
    
  } catch (error: any) {
    logger('error', '❌ Personality failed', {
      error: error.message,
      username: profile.username,
      requestId: this.requestId
    });
    
    return {
      disc_profile: 'Analysis failed',
      behavior_patterns: ['Unable to analyze'],
      communication_style: 'Unknown',
      motivation_drivers: ['Unable to determine'],
      content_authenticity: 'insufficient_data',
      data_confidence: 'low',
      cost: 0,
      tokens_in: 0,
      tokens_out: 0
    };
  }
}

  // ============================================================================
  // JSON PARSING UTILITY
  // ============================================================================

  private parseJsonResponse(content: string, analysisType: string): any {
    try {
      let cleanContent = content.trim();
      
      cleanContent = cleanContent
        .replace(/,\s*"confidence"/, ', "confidence"')
        .replace(/,\s*}/, '}')
        .replace(/,$/, '');
      
      logger('info', '🔍 Parsing JSON response', {
        analysisType,
        originalLength: content.length,
        cleanedLength: cleanContent.length,
        first100Chars: cleanContent.substring(0, 100),
        requestId: this.requestId
      });
      
      const parsed = JSON.parse(cleanContent);
      
      if (parsed.summary && !parsed.summary.match(/[.!?]$/)) {
        parsed.summary = parsed.summary.replace(/,$/, '.').trim();
      }
      
      logger('info', '✅ JSON parsed successfully', {
        analysisType,
        hasScore: 'score' in parsed,
        hasSummary: 'summary' in parsed,
        topLevelKeys: Object.keys(parsed).slice(0, 10),
        requestId: this.requestId
      });
      
      return parsed;
      
    } catch (parseError: any) {
      logger('error', '❌ JSON parse failed', {
        error: parseError.message,
        analysisType,
        contentPreview: content.substring(0, 300),
        requestId: this.requestId
      });
      
      // Fallback recovery
      const scoreMatch = content.match(/"score":\s*(\d+)/);
      const summaryMatch = content.match(/"summary":\s*"([^"]+)"/);
      const confidenceMatch = content.match(/"confidence":\s*([\d.]+)/);
      
      return {
        score: scoreMatch ? parseInt(scoreMatch[1]) : 0,
        summary: summaryMatch ? summaryMatch[1].replace(/,$/, '.') : 'Analysis completed',
        confidence: confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.5,
        niche_fit: scoreMatch ? parseInt(scoreMatch[1]) : 0,
        engagement_score: scoreMatch ? parseInt(scoreMatch[1]) : 0
      };
    }
  }
}
