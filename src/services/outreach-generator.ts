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

    // VALIDATION PHASE
    const validation = this.validateInputs(profile, business);
    if (!validation.isValid) {
      logger('error', '❌ Outreach validation failed', {
        errors: validation.errors,
        requestId: this.requestId
      });
      
      return this.createErrorResponse(validation.errors.join(', '));
    }

    // SAFE DATA EXTRACTION
    const safeData = this.extractSafeData(profile, business, analysisContext);
    
    logger('info', '✅ Outreach data extracted', {
      username: safeData.username,
      followerCount: safeData.followerCount,
      businessOffering: safeData.businessOffering,
      hasContextPrompt: !!safeData.contextPrompt,
      requestId: this.requestId
    });

    // AI GENERATION
    try {
      return await this.executeAIGeneration(safeData);
    } catch (error: any) {
      logger('error', '❌ Outreach AI generation failed', {
        error: error.message,
        stack: error.stack,
        username: safeData.username,
        requestId: this.requestId
      });
      
      return this.createErrorResponse(error.message);
    }
  }

  private validateInputs(profile: ProfileData, business: BusinessProfile): { 
    isValid: boolean; 
    errors: string[] 
  } {
    const errors: string[] = [];

    // Profile validation
    if (!profile) {
      errors.push('Profile is null/undefined');
    } else {
      logger('info', '🔍 Profile validation', {
        hasUsername: !!profile.username,
        username: profile.username,
        hasFollowerCount: profile.followersCount !== undefined,
        hasBio: !!profile.bio,
        requestId: this.requestId
      });

      if (!profile.username) {
        errors.push('Profile missing username');
      }
    }

    // Business validation
    if (!business) {
      errors.push('Business is null/undefined');
    } else {
      logger('info', '🔍 Business validation', {
        hasBusinessName: !!business.business_name,
        businessName: business.business_name,
        hasOneLiner: !!business.business_one_liner,
        hasTargetAudience: !!business.target_audience,
        businessKeys: Object.keys(business),
        requestId: this.requestId
      });

      if (!business.business_name) {
        errors.push('Business missing business_name');
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  private extractSafeData(
    profile: ProfileData, 
    business: BusinessProfile, 
    analysisContext?: AnalysisContext
  ) {
    const username = profile.username || 'Unknown';
    const followerCount = profile.followersCount ?? 0;
    const bio = profile.bio ?? 'No bio available';
    const isVerified = profile.isVerified ?? false;
    const isBusinessAccount = profile.isBusinessAccount ?? false;
    const businessOffering = business.business_one_liner ?? business.target_audience ?? 'Creator services';
    
    let contextPrompt = '';
    if (analysisContext) {
      const score = analysisContext.score ?? 'N/A';
      const nicheFit = analysisContext.niche_fit ?? 'N/A';
      const insights = analysisContext.key_insights ?? 'Standard outreach';
      const audienceType = analysisContext.audience_type ?? 'General';
      
      contextPrompt = `
Context from analysis:
- Partnership Score: ${score}/100
- Niche Fit: ${nicheFit}/100
- Key Insight: ${insights}
- Audience Type: ${audienceType}`;
    }

    return {
      username,
      followerCount,
      bio,
      isVerified,
      isBusinessAccount,
      businessName: business.business_name,
      businessOffering,
      contextPrompt
    };
  }

  private async executeAIGeneration(safeData: any): Promise<OutreachResult> {
    logger('info', '🤖 AI generation starting', {
      username: safeData.username,
      requestId: this.requestId
    });

    const response = await this.aiAdapter.executeRequest({
      model_name: 'gpt-5-mini',
      system_prompt: `You are an expert at writing personalized influencer outreach messages. 
      
Rules:
- Address them by name/username personally
- Reference specific details from their profile (follower count, niche, bio)
- Show genuine interest in their content/audience
- Clearly state the collaboration opportunity
- Include specific value proposition
- End with clear call-to-action
- Keep 150-250 words
- Professional but friendly tone
- Never use generic templates

Focus on mutual benefit and be specific about the opportunity.`,
      user_prompt: `Write outreach message for partnership:

Profile: @${safeData.username}
Followers: ${safeData.followerCount.toLocaleString()}
Bio: "${safeData.bio}"
Verified: ${safeData.isVerified ? 'Yes' : 'No'}
Business Account: ${safeData.isBusinessAccount ? 'Yes' : 'No'}

Your Business: ${safeData.businessName}
Offering: ${safeData.businessOffering}
${safeData.contextPrompt}

Write a compelling, personalized outreach message.`,
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
    
    logger('info', '✅ Outreach generated successfully', {
      username: safeData.username,
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

  private createErrorResponse(errorMessage: string): OutreachResult {
    return {
      outreach_message: `Outreach generation failed: ${errorMessage}`,
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
      model_used: 'error'
    };
  }
}
