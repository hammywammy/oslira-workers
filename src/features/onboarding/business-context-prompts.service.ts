// features/onboarding/business-context-prompts.service.ts

import type { OnboardingFormData } from '@/shared/types/business-context.types';

/**
 * BUSINESS CONTEXT PROMPT BUILDER
 * 
 * Builds prompts for 4 parallel AI calls:
 * 1. business_one_liner (140 char tagline)
 * 2. business_summary_generated (4 sentences)
 * 3. ideal_customer_profile (JSON formatting - NO business_summary)
 * 4. operational_metadata (JSON formatting - YES business_summary)
 */

export class BusinessContextPromptBuilder {

  // ===============================================================================
  // CALL 1: Business One-Liner (140 chars)
  // ===============================================================================

  buildOneLinerPrompt(data: OnboardingFormData): string {
    return `# TASK: Create Compelling Business Tagline

## INPUT DATA
**Business Description:** ${data.business_summary}
**Target Audience:** ${data.target_description}
**Industry:** ${data.industry}
**Primary Goal:** ${data.primary_objective}

## REQUIREMENTS
- Maximum 140 characters (strict limit)
- Capture what they do AND who they serve
- Make it punchy and memorable
- No jargon or buzzwords
- Focus on value delivered

## EXAMPLES (structure, not content)
- "Helping SaaS companies turn website visitors into paying customers through AI-powered conversion optimization"
- "Empowering fitness coaches to scale their practice with automated client management and personalized training plans"

Create a ONE-LINE tagline following this structure.`;
  }

  // ===============================================================================
  // CALL 2: Business Summary Generated (4 sentences)
  // ===============================================================================

  buildSummaryPrompt(data: OnboardingFormData): string {
    return `# TASK: Write Polished Business Description

## INPUT DATA
**Business Description:** ${data.business_summary}
**Target Audience:** ${data.target_description}
**Industry:** ${data.industry}
**Primary Goal:** ${data.primary_objective}
**Key Challenges They Solve:** ${data.challenges.join(', ')}

## REQUIREMENTS
- Exactly 4 sentences
- Sentence 1: What they do and who they serve
- Sentence 2: Their specialization and differentiation
- Sentence 3: The key problem they solve or value they deliver
- Sentence 4: Their approach or what makes them unique

## STYLE GUIDELINES
- Professional but conversational
- Clear and concise
- Avoid clichés and buzzwords
- Focus on concrete value, not vague claims
- Third person perspective

Write the 4-sentence business description now.`;
  }

  // ===============================================================================
  // CALL 3: Ideal Customer Profile (JSON - NO business_summary)
  // ===============================================================================

  buildICPJsonPrompt(data: OnboardingFormData): string {
    return `# TASK: Format Ideal Customer Profile Data as JSON

## INPUT DATA
**Business Description:** ${data.business_summary}
**Target Audience:** ${data.target_description}
**Industry:** ${data.industry}
**Min Followers:** ${data.icp_min_followers}
**Max Followers:** ${data.icp_max_followers}
**Brand Voice:** ${data.brand_voice}

## CRITICAL RULES
- Return ONLY the data provided above
- DO NOT add business_summary to the JSON output
- DO NOT invent or infer any additional fields
- Just organize the provided data into clean JSON structure

Return the JSON object now.`;
  }

  // ===============================================================================
  // CALL 4: Operational Metadata (JSON - YES business_summary)
  // ===============================================================================

  buildOperationalJsonPrompt(data: OnboardingFormData): string {
    return `# TASK: Format Operational Metadata as JSON

## INPUT DATA
**Business Summary:** ${data.business_summary}
**Company Size:** ${data.company_size}
**Monthly Lead Goal:** ${data.monthly_lead_goal}
**Primary Objective:** ${data.primary_objective}
**Challenges:** ${JSON.stringify(data.challenges)}
**Target Company Sizes:** ${JSON.stringify(data.target_company_sizes)}
**Communication Channels:** ${JSON.stringify(data.communication_channels)}
**Communication Tone:** ${data.brand_voice}
**Team Size:** ${data.team_size}
**Campaign Manager:** ${data.campaign_manager}

## CRITICAL RULES
- Return ALL the data provided above as JSON
- INCLUDE the business_summary field in the output
- DO NOT add or infer any additional fields
- Just organize the provided data into clean JSON structure

Return the JSON object now.`;
  }

  // ===============================================================================
  // JSON SCHEMAS FOR STRUCTURED OUTPUT
  // ===============================================================================

  getICPJsonSchema() {
    return {
      name: 'IdealCustomerProfile',
      description: 'Structured ideal customer profile data',
      parameters: {
        type: 'object',
        properties: {
          business_description: {
            type: 'string',
            description: 'What the business does'
          },
          target_audience: {
            type: 'string',
            description: 'Who the business serves'
          },
          industry: {
            type: 'string',
            description: 'Industry category'
          },
          icp_min_followers: {
            type: 'number',
            description: 'Minimum follower count for ideal customers'
          },
          icp_max_followers: {
            type: 'number',
            description: 'Maximum follower count for ideal customers'
          },
          brand_voice: {
            type: 'string',
            description: 'Communication tone preference'
          }
        },
        required: [
          'business_description',
          'target_audience',
          'industry',
          'icp_min_followers',
          'icp_max_followers',
          'brand_voice'
        ],
        additionalProperties: false
      }
    };
  }

  getOperationalJsonSchema() {
    return {
      name: 'OperationalMetadata',
      description: 'Structured operational business data',
      parameters: {
        type: 'object',
        properties: {
          business_summary: {
            type: 'string',
            description: 'User\'s business description'
          },
          company_size: {
            type: 'string',
            description: 'Company size category'
          },
          monthly_lead_goal: {
            type: 'number',
            description: 'Target number of leads per month'
          },
          primary_objective: {
            type: 'string',
            description: 'Main business objective'
          },
          challenges: {
            type: 'array',
            items: { type: 'string' },
            description: 'Business challenges being addressed'
          },
          target_company_sizes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Target customer company sizes'
          },
          communication_channels: {
            type: 'array',
            items: { type: 'string' },
            description: 'Preferred communication channels'
          },
          communication_tone: {
            type: 'string',
            description: 'Preferred communication tone'
          },
          team_size: {
            type: 'string',
            description: 'Internal team size'
          },
          campaign_manager: {
            type: 'string',
            description: 'Who manages campaigns'
          }
        },
        required: [
          'business_summary',
          'company_size',
          'monthly_lead_goal',
          'primary_objective',
          'challenges',
          'target_company_sizes',
          'communication_channels',
          'communication_tone',
          'team_size',
          'campaign_manager'
        ],
        additionalProperties: false
      }
    };
  }
}
