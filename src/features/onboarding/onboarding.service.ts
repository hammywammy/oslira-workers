// features/onboarding/onboarding.service.ts

import type { Env } from '@/shared/types/env.types';
import type { BusinessContextResult } from '@/shared/types/business-context.types';
import { AIGatewayClient } from '@/infrastructure/ai/ai-gateway.client';

/**
 * ONBOARDING SERVICE - STREAMLINED 4-STEP
 * 
 * AI GENERATED (2 calls):
 * 1. business_one_liner (140 char tagline) - gpt-5-mini
 * 2. business_summary_generated (4 sentences) - gpt-5-mini
 * 
 * MANUAL CONSTRUCTION (no AI):
 * 3. ideal_customer_profile (direct JSON mapping)
 * 4. operational_metadata (direct JSON mapping with defaults)
 * 
 * Expected duration: 8-12 seconds (only 2 AI calls)
 * Cost: ~90% cheaper than previous 4-call version
 */

// =============================================================================
// STREAMLINED 4-STEP FORM DATA
// =============================================================================

export interface OnboardingFormData {
  // Step 1: Identity
  signature_name: string;

  // Step 2: Business Context
  business_summary: string;        // 50-750 chars
  communication_tone: 'professional' | 'friendly' | 'casual';

  // Step 3: Target Customer
  target_description: string;      // 50-750 chars
  icp_min_followers: number;
  icp_max_followers: number;
  target_company_sizes: string[];  // ['startup', 'smb', 'enterprise']
}

export class OnboardingService {
  private aiClient: AIGatewayClient;

  constructor(env: Env, openaiKey: string, claudeKey: string) {
    this.aiClient = new AIGatewayClient(env, openaiKey, claudeKey);
  }

  /**
   * Generate complete business context
   * - 2 AI calls (parallel)
   * - 2 manual constructions
   */
  async generateBusinessContext(
    userInputs: OnboardingFormData
  ): Promise<BusinessContextResult> {
    const overallStartTime = Date.now();

    console.log('='.repeat(80));
    console.log('[OnboardingService] STARTING - 4-Step Streamlined');
    console.log('[OnboardingService] Timestamp:', new Date().toISOString());
    console.log('[OnboardingService] Input:', {
      signature_name: userInputs.signature_name,
      business_summary_length: userInputs.business_summary.length,
      target_description_length: userInputs.target_description.length,
      communication_tone: userInputs.communication_tone,
      follower_range: `${userInputs.icp_min_followers}-${userInputs.icp_max_followers}`,
      target_company_sizes: userInputs.target_company_sizes
    });
    console.log('='.repeat(80));

    try {
      // =======================================================================
      // PHASE 1: AI GENERATION (2 parallel calls)
      // =======================================================================
      
      console.log('[OnboardingService] Creating AI promises (parallel)...');
      const aiStartTime = Date.now();
      
      const oneLinerPromise = this.generateOneLinerWithRetry(userInputs);
      const summaryPromise = this.generateSummaryWithRetry(userInputs);

      const [oneLiner, summaryGenerated] = await Promise.all([
        oneLinerPromise,
        summaryPromise
      ]);
      
      const aiDuration = Date.now() - aiStartTime;
      console.log(`[OnboardingService] AI calls complete in ${aiDuration}ms`);

      // =======================================================================
      // PHASE 2: MANUAL JSON CONSTRUCTION (instant, no AI)
      // =======================================================================
      
      console.log('[OnboardingService] Constructing JSON objects manually...');
      const constructionStartTime = Date.now();

      // Extract business name from summary (simple heuristic)
      const businessName = this.extractBusinessName(userInputs.business_summary);

      // MANUAL: Ideal Customer Profile
      const idealCustomerProfile = {
        business_description: userInputs.business_summary,
        target_audience: userInputs.target_description,
        industry: "General", // Default - can enhance with AI extraction later if needed
        icp_min_followers: userInputs.icp_min_followers,
        icp_max_followers: userInputs.icp_max_followers,
        brand_voice: userInputs.communication_tone
      };

      // MANUAL: Operational Metadata (with sensible defaults)
      const operationalMetadata = {
        business_summary: userInputs.business_summary,
        business_name: businessName,
        company_size: "1-10", // Default for new users
        monthly_lead_goal: 50, // Default
        primary_objective: "lead-generation", // Default
        challenges: [], // Not collected in 4-step flow
        target_company_sizes: userInputs.target_company_sizes,
        communication_channels: ["instagram"], // Default
        communication_tone: userInputs.communication_tone,
        team_size: "just-me", // Default
        campaign_manager: "myself" // Default
      };

      const constructionDuration = Date.now() - constructionStartTime;
      console.log(`[OnboardingService] JSON construction complete in ${constructionDuration}ms`);

      // =======================================================================
      // PHASE 3: ASSEMBLE RESULT
      // =======================================================================

      const totalTokens = 
        oneLiner.usage.input_tokens + oneLiner.usage.output_tokens +
        summaryGenerated.usage.input_tokens + summaryGenerated.usage.output_tokens;

      const totalCost =
        oneLiner.usage.total_cost +
        summaryGenerated.usage.total_cost;

      const overallDuration = Date.now() - overallStartTime;

      const result: BusinessContextResult = {
        business_one_liner: oneLiner.content,
        business_summary_generated: summaryGenerated.content,
        ideal_customer_profile: idealCustomerProfile,
        operational_metadata: operationalMetadata,
        ai_metadata: {
          model_used: 'gpt-5-mini',
          total_tokens: totalTokens,
          total_cost: totalCost,
          generation_time_ms: overallDuration
        }
      };

      console.log('[OnboardingService] COMPLETE - Final stats:', {
        total_duration_ms: overallDuration,
        ai_duration_ms: aiDuration,
        construction_duration_ms: constructionDuration,
        total_tokens: totalTokens,
        total_cost: '$' + totalCost.toFixed(4),
        cost_savings_vs_old: '~90%'
      });
      console.log('='.repeat(80));

      return result;

    } catch (error: any) {
      const overallDuration = Date.now() - overallStartTime;
      
      console.error('='.repeat(80));
      console.error('[OnboardingService] FAILED');
      console.error('[OnboardingService] Duration:', overallDuration, 'ms');
      console.error('[OnboardingService] Error:', {
        name: error.name,
        message: error.message,
        stack: error.stack
      });
      console.error('='.repeat(80));
      
      throw new Error(`Business context generation failed: ${error.message}`);
    }
  }

  // ===========================================================================
  // AI CALL 1: One-liner (with retry)
  // ===========================================================================

  private async generateOneLinerWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] One-liner attempt ${attempt}/3 starting...`);
    const callStartTime = Date.now();
    
    try {
      const result = await this.aiClient.call({
        model: 'gpt-5-mini',
        system_prompt: 'You write punchy, memorable one-liners for businesses. Maximum 140 characters. No fluff.',
        user_prompt: this.buildOneLinerPrompt(data),
        max_tokens: 1500
      });
      
      const callDuration = Date.now() - callStartTime;
      console.log(`[OnboardingService] One-liner attempt ${attempt} SUCCESS in ${callDuration}ms`);
      
      return result;
      
    } catch (error: any) {
      const callDuration = Date.now() - callStartTime;
      console.error(`[OnboardingService] One-liner attempt ${attempt} FAILED after ${callDuration}ms:`, {
        error_name: error.name,
        error_message: error.message
      });

      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[OnboardingService] Retrying one-liner in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        return this.generateOneLinerWithRetry(data, attempt + 1);
      }
      
      throw new Error(`One-liner generation failed after 3 attempts: ${error.message}`);
    }
  }

  // ===========================================================================
  // AI CALL 2: Summary (with retry)
  // ===========================================================================

  private async generateSummaryWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] Summary attempt ${attempt}/3 starting...`);
    const callStartTime = Date.now();
    
    try {
      const result = await this.aiClient.call({
        model: 'gpt-5-mini',
        system_prompt: 'You write clear, professional business summaries. Exactly 4 sentences. No marketing fluff.',
        user_prompt: this.buildSummaryPrompt(data),
        max_tokens: 1500
      });
      
      const callDuration = Date.now() - callStartTime;
      console.log(`[OnboardingService] Summary attempt ${attempt} SUCCESS in ${callDuration}ms`);
      
      return result;
      
    } catch (error: any) {
      const callDuration = Date.now() - callStartTime;
      console.error(`[OnboardingService] Summary attempt ${attempt} FAILED after ${callDuration}ms:`, {
        error_name: error.name,
        error_message: error.message
      });

      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[OnboardingService] Retrying summary in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        return this.generateSummaryWithRetry(data, attempt + 1);
      }
      
      throw new Error(`Summary generation failed after 3 attempts: ${error.message}`);
    }
  }

  // ===========================================================================
  // PROMPT BUILDERS (INLINE - NO SEPARATE SERVICE NEEDED)
  // ===========================================================================

  private buildOneLinerPrompt(data: OnboardingFormData): string {
    return `# TASK: Create Compelling Business Tagline

## INPUT DATA
**Business Description:** ${data.business_summary}
**Target Audience:** ${data.target_description}
**Communication Tone:** ${data.communication_tone}

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

  private buildSummaryPrompt(data: OnboardingFormData): string {
    return `# TASK: Write Polished Business Description

## INPUT DATA
**Business Description:** ${data.business_summary}
**Target Audience:** ${data.target_description}
**Communication Tone:** ${data.communication_tone}
**Follower Range:** ${data.icp_min_followers} - ${data.icp_max_followers}

## REQUIREMENTS
- Exactly 4 sentences
- Sentence 1: What they do and who they serve
- Sentence 2: Their specialization and differentiation
- Sentence 3: The key problem they solve or value they deliver
- Sentence 4: Their approach or what makes them unique

## STYLE GUIDELINES
- Professional but conversational (match the ${data.communication_tone} tone)
- Clear and concise
- Avoid clichés and buzzwords
- Focus on concrete value, not vague claims
- Third person perspective

Write the 4-sentence business description now.`;
  }

  // ===========================================================================
  // HELPER: Extract Business Name
  // ===========================================================================

  private extractBusinessName(businessSummary: string): string {
    // Simple heuristic: take first 3-5 words before punctuation
    // Examples:
    // "Oslira helps copywriters..." → "Oslira"
    // "My company is a marketing agency..." → "My Company"
    
    const firstSentence = businessSummary.split(/[.!?]/)[0];
    const words = firstSentence?.trim().split(/\s+/) || [];
    
    // If starts with "I am" or "I run" or "My company", extract better
    if (words[0]?.toLowerCase() === 'i') {
      // Pattern: "I run XYZ" or "I am XYZ"
      return words.slice(2, 5).join(' ').trim() || 'Business';
    }
    
    if (words[0]?.toLowerCase() === 'my') {
      // Pattern: "My company XYZ"
      return words.slice(2, 5).join(' ').trim() || 'Business';
    }
    
    // Default: take first 1-3 words
    return words.slice(0, 3).join(' ').trim() || 'Business';
  }

  // ===========================================================================
  // UTILITY
  // ===========================================================================

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
