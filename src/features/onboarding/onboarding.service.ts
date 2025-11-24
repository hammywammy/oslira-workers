// features/onboarding/onboarding.service.ts

import type { Env } from '@/shared/types/env.types';
import type { BusinessContextResult } from '@/shared/types/business-context.types';
import { AIGatewayClient } from '@/infrastructure/ai/ai-gateway.client';

export interface OnboardingFormData {
  full_name: string;
  business_summary: string;
  communication_tone: 'professional' | 'friendly' | 'casual';
  target_description: string;
  icp_min_followers: number;
  icp_max_followers: number;
  target_company_sizes: string[];
}

export class OnboardingService {
  private aiClient: AIGatewayClient;

  constructor(env: Env, openaiKey: string, claudeKey: string, private aiGatewayToken: string) {
    this.aiClient = new AIGatewayClient(env, openaiKey, claudeKey, aiGatewayToken);
  }

  async generateBusinessContext(userInputs: OnboardingFormData): Promise<BusinessContextResult> {
    const overallStartTime = Date.now();

    console.log('[OnboardingService] Starting 4-step generation...');

    try {
      // AI GENERATION (2 parallel calls)
      const [oneLiner, summaryGenerated] = await Promise.all([
        this.generateOneLinerWithRetry(userInputs),
        this.generateSummaryWithRetry(userInputs)
      ]);
      
      const aiDuration = Date.now() - overallStartTime;

      // BUILD BUSINESS CONTEXT JSON
      const businessContext = {
        // User inputs from onboarding
        business_summary: userInputs.business_summary,
        communication_tone: userInputs.communication_tone,
        target_description: userInputs.target_description,
        icp_min_followers: userInputs.icp_min_followers,
        icp_max_followers: userInputs.icp_max_followers,
        target_company_sizes: userInputs.target_company_sizes,
        
        // AI metadata
        ai_generation: {
          model_used: 'gpt-5-mini',
          total_tokens: oneLiner.usage.input_tokens + oneLiner.usage.output_tokens + 
                        summaryGenerated.usage.input_tokens + summaryGenerated.usage.output_tokens,
          total_cost: oneLiner.usage.total_cost + summaryGenerated.usage.total_cost,
          generation_time_ms: aiDuration,
          generated_at: new Date().toISOString()
        }
      };

      const result: BusinessContextResult = {
        business_one_liner: oneLiner.content,
        business_summary_generated: summaryGenerated.content,
        business_context: businessContext
      };

      console.log('[OnboardingService] COMPLETE', {
        duration_ms: aiDuration,
        cost: businessContext.ai_generation.total_cost
      });

      return result;

    } catch (error: any) {
      console.error('[OnboardingService] FAILED:', error.message);
      throw new Error(`Business context generation failed: ${error.message}`);
    }
  }

  private async generateOneLinerWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] One-liner attempt ${attempt}/3...`);
    
    try {
      const result = await this.aiClient.call({
        model: 'gpt-5-mini',
        system_prompt: 'You write punchy, memorable one-liners for businesses. Maximum 140 characters. No fluff.',
        user_prompt: this.buildOneLinerPrompt(data),
        max_tokens: 1500
      });
      
      console.log(`[OnboardingService] One-liner SUCCESS`);
      return result;
      
    } catch (error: any) {
      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        await this.sleep(backoffMs);
        return this.generateOneLinerWithRetry(data, attempt + 1);
      }
      throw new Error(`One-liner generation failed: ${error.message}`);
    }
  }

  private async generateSummaryWithRetry(data: OnboardingFormData, attempt = 1): Promise<any> {
    console.log(`[OnboardingService] Summary attempt ${attempt}/3...`);
    
    try {
      const result = await this.aiClient.call({
        model: 'gpt-5-mini',
        system_prompt: 'You write clear, professional business summaries. Exactly 4 sentences. No marketing fluff.',
        user_prompt: this.buildSummaryPrompt(data),
        max_tokens: 1500
      });
      
      console.log(`[OnboardingService] Summary SUCCESS`);
      return result;
      
    } catch (error: any) {
      if (attempt < 3) {
        const backoffMs = Math.pow(2, attempt) * 1000;
        await this.sleep(backoffMs);
        return this.generateSummaryWithRetry(data, attempt + 1);
      }
      throw new Error(`Summary generation failed: ${error.message}`);
    }
  }

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

Create a ONE-LINE tagline.`;
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
- Match the ${data.communication_tone} tone
- Clear and concise
- Avoid clichés and buzzwords
- Focus on concrete value
- Third person perspective

Write the 4-sentence business description now.`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
