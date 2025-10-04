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
  analysisContext?: {
    score?: number;
    niche_fit?: number;
    key_insights?: string;
    audience_type?: string;
  }
): Promise<OutreachResult> {
  
// Validate required inputs with detailed logging
const validationErrors: string[] = [];

if (!profile) {
  validationErrors.push('Profile is null/undefined');
} else if (!profile.username) {
  validationErrors.push('Profile missing username');
}

if (!business) {
  validationErrors.push('Business is null/undefined');
} else {
  // Log business object structure for debugging
  logger('info', 'Business object structure', {
    hasBusinessName: !!business.business_name,
    hasOneLiner: !!business.business_one_liner,
    hasTargetAudience: !!business.target_audience,
    businessKeys: Object.keys(business),
    requestId: this.requestId
  });
  
  if (!business.business_name) {
    validationErrors.push('Business missing business_name');
  }
}
  
  if (validationErrors.length > 0) {
    logger('error', 'Outreach generation validation failed', {
      errors: validationErrors,
      hasProfile: !!profile,
      hasBusiness: !!business,
      requestId: this.requestId
    });
    
    return {
      outreach_message: `Outreach generation failed: ${validationErrors.join(', ')}`,
      cost: 0,
      tokens_in: 0,
      tokens_out: 0,
      model_used: 'validation-failed'
    };
  }

  // Safe extraction with defaults
  const followerCount = profile.followersCount ?? 0;
  const bio = profile.bio ?? 'No bio available';
  const isVerified = profile.isVerified ?? false;
  const isBusinessAccount = profile.isBusinessAccount ?? false;
  const businessOffering = business.business_one_liner ?? business.target_audience ?? 'Creator services';
  
  // Build context string
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

  try {
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

Profile: @${profile.username}
Followers: ${followerCount.toLocaleString()}
Bio: "${bio}"
Verified: ${isVerified ? 'Yes' : 'No'}
Business Account: ${isBusinessAccount ? 'Yes' : 'No'}

Your Business: ${business.business_name}
Offering: ${businessOffering}
${contextPrompt}

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

    const parsed = JSON.parse(response.content);
    
    logger('info', 'Outreach generated', {
      username: profile.username,
      message_length: parsed.outreach_message?.length ?? 0,
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
    
  } catch (error: any) {
    logger('error', 'Outreach generation API call failed', {
      error: error.message,
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
}
