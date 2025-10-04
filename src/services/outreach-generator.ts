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

export class OutreachGenerator {
  private aiAdapter: UniversalAIAdapter;
  private requestId: string;

  constructor(env: any, requestId: string) {
    this.aiAdapter = new UniversalAIAdapter(env, requestId);
    this.requestId = requestId;
  }

  async generate(
    profile: ProfileData, 
    business: any,
    analysisContext?: {
      score?: number;
      niche_fit?: number;
      key_insights?: string;
      audience_type?: string;
    }
  ): Promise<OutreachResult> {
    
    // Build context-aware prompt
    let contextPrompt = '';
    if (analysisContext) {
      contextPrompt = `
Context from analysis:
- Partnership Score: ${analysisContext.score || 'N/A'}/100
- Niche Fit: ${analysisContext.niche_fit || 'N/A'}/100
- Key Insight: ${analysisContext.key_insights || 'Standard outreach'}
- Audience Type: ${analysisContext.audience_type || 'General'}`;
    }

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
Followers: ${profile.followersCount.toLocaleString()}
Bio: "${profile.bio || 'No bio'}"
Verified: ${profile.isVerified ? 'Yes' : 'No'}
Business Account: ${profile.isBusinessAccount ? 'Yes' : 'No'}

Your Business: ${business.business_name}
Offering: ${business.business_one_liner || business.target_audience}
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
      message_length: parsed.outreach_message.length,
      cost: response.usage.total_cost,
      requestId: this.requestId
    });

    return {
      outreach_message: parsed.outreach_message,
      cost: response.usage.total_cost,
      tokens_in: response.usage.input_tokens,
      tokens_out: response.usage.output_tokens,
      model_used: response.model_used
    };
  }
}
