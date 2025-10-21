// infrastructure/ai/ai-gateway.client.ts

import type { Env } from '@/shared/types/env.types';
import { AI_PRICING, calculateAICost } from './pricing.config';

export interface AIRequest {
  model: string;
  system_prompt: string;
  user_prompt: string;
  max_tokens: number;
  temperature?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
  json_schema?: any;
}

export interface AIResponse {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_cost: number;
  };
  model_used: string;
  provider: 'openai' | 'anthropic';
}

export class AIGatewayClient {
  private openaiBaseURL: string;
  private claudeBaseURL: string;
  
  constructor(
    private env: Env,
    private openaiKey: string,
    private claudeKey: string
  ) {
    // AI Gateway URLs (30-40% cost savings via caching)
    this.openaiBaseURL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/openai`;
    this.claudeBaseURL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/anthropic`;
  }

  /**
   * Universal AI call - handles OpenAI and Claude
   */
  async call(request: AIRequest): Promise<AIResponse> {
    const pricing = AI_PRICING[request.model];
    if (!pricing) {
      throw new Error(`Unknown model: ${request.model}`);
    }

    if (pricing.provider === 'openai') {
      return await this.callOpenAI(request, pricing);
    } else {
      return await this.callClaude(request, pricing);
    }
  }

  /**
   * OpenAI API call via AI Gateway
   */
  private async callOpenAI(request: AIRequest, pricing: any): Promise<AIResponse> {
    const body: any = {
      model: request.model,
      messages: [
        { role: 'system', content: request.system_prompt },
        { role: 'user', content: request.user_prompt }
      ],
      max_completion_tokens: request.max_tokens,
      temperature: request.temperature ?? 0
    };

    // Add reasoning_effort for o1 models
    if (request.reasoning_effort) {
      body.reasoning_effort = request.reasoning_effort;
    }

    // Add JSON schema if provided
    if (request.json_schema && pricing.supports_json_schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: request.json_schema
      };
    }

    const response = await fetch(`${this.openaiBaseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.openaiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    const usage = data.usage || {};
    const totalCost = calculateAICost(
      request.model,
      usage.prompt_tokens || 0,
      usage.completion_tokens || 0
    );

    return {
      content: data.choices[0].message.content,
      usage: {
        input_tokens: usage.prompt_tokens || 0,
        output_tokens: usage.completion_tokens || 0,
        total_cost: totalCost
      },
      model_used: request.model,
      provider: 'openai'
    };
  }

  /**
   * Claude API call via AI Gateway
   */
  private async callClaude(request: AIRequest, pricing: any): Promise<AIResponse> {
    const body = {
      model: request.model,
      system: request.system_prompt,
      messages: [
        { role: 'user', content: request.user_prompt }
      ],
      max_tokens: request.max_tokens,
      temperature: request.temperature ?? 0
    };

    const response = await fetch(`${this.claudeBaseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error: ${response.status} - ${error}`);
    }

    const data = await response.json();

    const usage = data.usage || {};
    const totalCost = calculateAICost(
      request.model,
      usage.input_tokens || 0,
      usage.output_tokens || 0
    );

    return {
      content: data.content[0].text,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        total_cost: totalCost
      },
      model_used: request.model,
      provider: 'anthropic'
    };
  }
}
