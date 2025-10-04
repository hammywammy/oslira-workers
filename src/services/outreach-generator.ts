// ===============================================================================
// OUTREACH GENERATOR - COMPLETE REWRITE
// Token limit increased to 2000, prompts condensed, maximized intelligence
// ===============================================================================

import { UniversalAIAdapter } from './universal-ai-adapter.js';
import { logger } from '../utils/logger.js';
import type { ProfileData } from '../types/interfaces.js';

export interface OutreachResult {
  outreach_message: string;
  cost: number;
  tokens_in: number;
  tokens_out: number;
  model_used: string;
}

interface BusinessProfile {
  business_name: string;
  business_one_liner?: string;
  target_audience?: string;
}

interface AnalysisContext {
  score?: number;
  niche_fit?: number;
  key_insights?: string;
  audience_type?: string;
}

export class OutreachGenerator {
  private aiAdapter: UniversalAIAdapter;
  private requestId: string;

  constructor(env: any, requestId: string) {
    this.aiAdapter = new UniversalAIAdapter(env, requestId);
    this.requestId = requestId;
  }

  async generate(
    profile: ProfileData, 
    business: BusinessProfile,
    analysisContext?: AnalysisContext
  ): Promise<OutreachResult> {
    
    logger('info', '📧 Outreach generation initiated', {
      username: profile?.username,
      businessName: business?.business_name,
      hasContext: !!analysisContext,
      requestId: this.requestId
    });

    // Quick validation
    if (!profile?.username || !business?.business_name) {
      logger('error', '❌ Outreach validation failed', {
        hasProfile: !!profile,
        hasUsername: !!profile?.username,
        hasBusiness: !!business,
        hasBusinessName: !!business?.business_name,
        requestId: this.requestId
      });
      
      return {
        outreach_message: 'Outreach generation failed: Missing profile or business data',
        cost: 0,
        tokens_in: 0,
        tokens_out: 0,
        model_used: 'error'
      };
    }

    try {
      return await this.executeGeneration(profile, business, analysisContext);
    } catch (error: any) {
      logger('error', '❌ Outreach generation failed', {
        error: error.message,
        stack: error.stack,
        username: profile.username,
        requestId: this.requestId
      });
      
      return {
        outreach_message: `Outreach generation failed: ${error.message}`,
        cost: 0,
        tokens_in: 0,
        tokens_out: 0,
        model_used: 'error'
      };
    }
  }

  private async executeGeneration(
    profile: ProfileData, 
    business: BusinessProfile,
    context?: AnalysisContext
  ): Promise<OutreachResult> {
    
    const response = await this.aiAdapter.executeRequest({
      model_name: 'gpt-5-mini',
      system_prompt: 'Write concise partnership outreach. Keep under 150 words. Personal, specific, direct.',
      user_prompt: this.buildPrompt(profile, business, context),
      max_tokens: 2000,
      json_schema: {
        name: 'OutreachMessage',
        strict: true,
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            outreach_message: { type: 'string', maxLength: 800 }
          },
          required: ['outreach_message']
        }
      },
      response_format: 'json',
      temperature: 0.6,
      analysis_type: 'outreach'
    });

    logger('info', '✅ AI response received', {
      hasContent: !!response.content,
      contentLength: response.content?.length,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cost: response.usage.total_cost,
      requestId: this.requestId
    });

    const parsed = JSON.parse(response.content);
    
    logger('info', '✅ Outreach generated', {
      username: profile.username,
      messageLength: parsed.outreach_message?.length ?? 0,
      cost: response.usage.total_cost,
      requestId: this.requestId
    });

    return {
      outreach_message: parsed.outreach_message ?? 'Generation failed',
      cost: response.usage.total_cost,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
      model_used: response.model_used
    };
  }

  private buildPrompt(
    profile: ProfileData, 
    business: BusinessProfile, 
    context?: AnalysisContext
  ): string {
    
    const bio = profile.bio?.slice(0, 100) || 'No bio';
    const followers = profile.followersCount?.toLocaleString() || '0';
    const businessDesc = business.business_one_liner || business.target_audience || business.business_name;
    
    let prompt = `Outreach to @${profile.username}

Bio: "${bio}"
Followers: ${followers}${profile.isVerified ? ' ✓' : ''}

Your Company: ${business.business_name}
What You Do: ${businessDesc}`;

    if (context) {
      prompt += `\nFit Score: ${context.score || 'N/A'}/100`;
      if (context.key_insights) {
        prompt += `\nInsight: ${context.key_insights.slice(0, 80)}`;
      }
    }

    prompt += `\n\nWrite personalized DM:
- Use their name
- Reference bio/niche
- State opportunity clearly
- Show mutual value
- 100-150 words max
- Professional but warm
- End with clear next step`;

    return prompt;
  }
}
