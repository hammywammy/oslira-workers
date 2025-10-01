//DONT TOUCH THIS FILE, onboarding uses it
import type { Context } from 'hono';
import type { Env } from '../types/interfaces.js';
import { generateRequestId, logger } from '../utils/logger.js';
import { createStandardResponse } from '../utils/response.js';
import { UniversalAIAdapter, selectModel } from '../services/universal-ai-adapter.js';

export async function handleGenerateBusinessContext(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    logger('info', 'Business context generation request received', { requestId });

    const body = await c.req.json();
    const { business_data, user_id, request_type } = body;
    
    if (!business_data || !user_id) {
      return c.json(createStandardResponse(false, undefined, 'business_data and user_id are required', requestId), 400);
    }

    // Validate required business fields
    const requiredFields = ['business_name', 'business_niche', 'target_audience', 'value_proposition'];
    const missingFields = requiredFields.filter(field => !business_data[field] || business_data[field].trim().length === 0);
    
    if (missingFields.length > 0) {
      return c.json(createStandardResponse(false, undefined, `Missing required fields: ${missingFields.join(', ')}`, requestId), 400);
    }

    logger('info', 'Generating business context with GPT-5 Mini', { 
      business_name: business_data.business_name,
      user_id,
      requestId 
    });

    // Use GPT-5 Mini for context generation (economy tier)
    const modelName = selectModel('context', 'economy');
    const aiAdapter = new UniversalAIAdapter(c.env, requestId);
    
    const prompt = buildBusinessContextPrompt(business_data);
    
const response = await aiAdapter.executeRequest({
  model_name: modelName,
  system_prompt: 'You are a business intelligence analyst specializing in creating comprehensive business profiles for B2B outreach. Generate structured business context data that will be used for AI-powered influencer outreach personalization.',
  user_prompt: prompt,
  max_tokens: 2500,
  json_schema: getBusinessContextJsonSchema(),
  response_format: 'json',
  temperature: 0.3,
  reasoning_effort: 'low'
});
    const contextResult = JSON.parse(response.content);
    
    logger('info', 'Business context generated successfully', {
      one_liner_length: contextResult.business_one_liner?.length,
      context_sections: Object.keys(contextResult.business_context_pack || {}).length,
      model_used: response.model_used,
      total_cost: response.usage.total_cost,
      requestId
    });

    return c.json(createStandardResponse(true, {
      business_one_liner: contextResult.business_one_liner,
      business_context_pack: contextResult.business_context_pack,
      context_version: 'v1.0',
      generated_at: new Date().toISOString(),
      ai_metadata: {
        model_used: response.model_used,
        tokens_used: response.usage.input_tokens + response.usage.output_tokens,
        generation_cost: response.usage.total_cost,
        request_id: requestId
      }
    }, undefined, requestId));

  } catch (error: any) {
    logger('error', 'Business context generation failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}

function buildBusinessContextPrompt(businessData: any): string {
  return `# BUSINESS CONTEXT GENERATION

## BUSINESS DATA
**Name:** ${businessData.business_name}
**Niche:** ${businessData.business_niche}
**Target Audience:** ${businessData.target_audience}
**Problems Solved:** ${businessData.target_problems || 'Not provided'}
**Value Proposition:** ${businessData.value_proposition}
**Success Outcomes:** ${businessData.success_outcome || 'Not provided'}
**Communication Style:** ${businessData.communication_style || 'Not provided'}
**Primary Objective:** ${businessData.primary_objective || 'Not provided'}
**Sample Message:** ${businessData.message_example || 'Not provided'}

## TASK: Generate Business Intelligence Context

Create a comprehensive business context profile that will be used for AI-powered influencer outreach personalization.

### REQUIREMENTS:

**business_one_liner**: Create a compelling 140-character business description that captures the essence of what this business does and who they serve. Make it punchy and memorable.

**business_context_pack**: Generate a structured JSON object with these sections:

1. **industry_profile**: Categorize the business (marketing, healthcare, tech, finance, etc.) and identify key industry characteristics
2. **audience_intelligence**: Analyze the target audience - demographics, psychographics, pain points, motivations
3. **value_framework**: Break down the unique value proposition into key selling points and differentiators
4. **communication_DNA**: Analyze their preferred communication style and tone indicators from their sample message
5. **outreach_strategy**: Optimal approach angles for influencer partnerships based on their objectives
6. **personalization_hooks**: Key data points that should be used to personalize outreach messages

### OUTPUT FORMAT:
Return valid JSON with no markdown formatting:
{
  "business_one_liner": "Compelling 140-char description",
  "business_context_pack": {
    "industry_profile": {...},
    "audience_intelligence": {...},
    "value_framework": {...},
    "communication_DNA": {...},
    "outreach_strategy": {...},
    "personalization_hooks": [...]
  }
}

Focus on creating actionable intelligence that will help generate highly personalized outreach messages to influencers.`;
}

function getBusinessContextJsonSchema() {
  return {
    name: 'BusinessContextResult',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        business_one_liner: { 
          type: 'string',
          maxLength: 140,
          description: 'Compelling business description under 140 characters'
        },
        business_context_pack: {
          type: 'object',
          additionalProperties: false,
          properties: {
            industry_profile: {
              type: 'object',
              additionalProperties: false,
              properties: {
                category: { type: 'string' },
                characteristics: { type: 'array', items: { type: 'string' } },
                competitive_landscape: { type: 'string' }
              },
              required: ['category', 'characteristics', 'competitive_landscape']
            },
            audience_intelligence: {
              type: 'object',
              additionalProperties: false,
              properties: {
                demographics: { type: 'string' },
                psychographics: { type: 'string' },
                core_pain_points: { type: 'array', items: { type: 'string' } },
                decision_triggers: { type: 'array', items: { type: 'string' } }
              },
              required: ['demographics', 'psychographics', 'core_pain_points', 'decision_triggers']
            },
            value_framework: {
              type: 'object',
              additionalProperties: false,
              properties: {
                primary_benefits: { type: 'array', items: { type: 'string' } },
                unique_differentiators: { type: 'array', items: { type: 'string' } },
                proof_points: { type: 'array', items: { type: 'string' } }
              },
              required: ['primary_benefits', 'unique_differentiators', 'proof_points']
            },
            communication_DNA: {
              type: 'object',
              additionalProperties: false,
              properties: {
                tone_style: { type: 'string' },
                key_messaging_themes: { type: 'array', items: { type: 'string' } },
                language_preferences: { type: 'array', items: { type: 'string' } }
              },
              required: ['tone_style', 'key_messaging_themes', 'language_preferences']
            },
            outreach_strategy: {
              type: 'object',
              additionalProperties: false,
              properties: {
                optimal_approach_angles: { type: 'array', items: { type: 'string' } },
                partnership_value_props: { type: 'array', items: { type: 'string' } },
                collaboration_formats: { type: 'array', items: { type: 'string' } }
              },
              required: ['optimal_approach_angles', 'partnership_value_props', 'collaboration_formats']
            },
            personalization_hooks: {
              type: 'array',
              items: { type: 'string' },
              minItems: 3,
              maxItems: 8,
              description: 'Key data points for personalizing outreach messages'
            }
          },
          required: ['industry_profile', 'audience_intelligence', 'value_framework', 'communication_DNA', 'outreach_strategy', 'personalization_hooks']
        }
      },
      required: ['business_one_liner', 'business_context_pack']
    }
  };
}
