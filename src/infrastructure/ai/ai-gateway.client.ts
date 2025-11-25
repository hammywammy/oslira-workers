// infrastructure/ai/ai-gateway.client.ts

import type { Env } from '@/shared/types/env.types';
import { AI_MODEL_PRICING, calculateAICost } from '@/config/operations-pricing.config';

/**
 * AI GATEWAY CLIENT - PRODUCTION VERSION
 * 
 * Handles all AI API calls through Cloudflare AI Gateway:
 * - OpenAI (GPT-5 family) via Chat Completions API
 * - Anthropic (Claude) via Messages API
 * 
 * Features:
 * - Automatic cost tracking
 * - Structured output via tool calling (GPT-5)
 * - Comprehensive error handling
 * - Request/response logging
 * 
 * CRITICAL: Uses Chat Completions API format (not Responses API)
 * - max_completion_tokens (not max_output_tokens)
 * - reasoning_effort at top level (not nested)
 * - No verbosity parameter (Chat Completions doesn't support it)
 */

// ===============================================================================
// REQUEST TYPES
// ===============================================================================

export interface AIRequest {
  model: string;
  system_prompt: string;
  user_prompt: string;
  max_tokens: number;
  temperature?: number;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  json_schema?: any;
}

export interface GPT5StructuredRequest {
  model: string;
  system_prompt: string;
  user_prompt: string;
  max_tokens: number;
  reasoning_effort?: 'minimal' | 'low' | 'medium' | 'high';
  tool_schema: {
    name: string;
    description: string;
    parameters: any;
  };
}

// ===============================================================================
// RESPONSE TYPES
// ===============================================================================

export interface AIResponse {
  content: string | any;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_cost: number;
  };
  model_used: string;
  provider: 'openai' | 'anthropic';
}

// ===============================================================================
// CLIENT
// ===============================================================================

export class AIGatewayClient {
  private openaiBaseURL: string;
  private claudeBaseURL: string;

  constructor(
    private env: Env,
    private openaiKey: string,
    private claudeKey: string,
    private aiGatewayToken: string
  ) {
    this.openaiBaseURL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/openai`;
    this.claudeBaseURL = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_NAME}/anthropic`;
  }

  /**
   * Universal AI call - auto-routes to OpenAI or Claude based on model
   */
  async call(request: AIRequest): Promise<AIResponse> {
    const pricing = AI_MODEL_PRICING[request.model];

    if (!pricing) {
      throw new Error(`Unknown model: ${request.model}. Available models: ${Object.keys(AI_MODEL_PRICING).join(', ')}`);
    }

    if (pricing.provider === 'openai') {
      return await this.callOpenAI(request, pricing);
    } else {
      return await this.callClaude(request, pricing);
    }
  }

  /**
   * GPT-5 structured output via tool calling
   * Returns parsed JSON object from tool call
   */
  async callStructured(request: GPT5StructuredRequest): Promise<AIResponse> {
    console.log('[AIGateway] Structured call starting:', {
      model: request.model,
      max_tokens: request.max_tokens,
      reasoning_effort: request.reasoning_effort,
      tool_name: request.tool_schema.name
    });

    // Build request body for Chat Completions API
    const body: any = {
      model: request.model,
      messages: [
        { role: 'system', content: request.system_prompt },
        { role: 'user', content: request.user_prompt }
      ],
      max_completion_tokens: request.max_tokens, // ✅ FIXED: Correct parameter name
      tools: [{
        type: 'function',
        function: {
          name: request.tool_schema.name,
          description: request.tool_schema.description,
          parameters: request.tool_schema.parameters
        }
      }],
      tool_choice: {
        type: 'function',
        function: { name: request.tool_schema.name }
      }
    };

    // Add reasoning_effort if specified (top-level, not nested)
    if (request.reasoning_effort) {
      body.reasoning_effort = request.reasoning_effort; // ✅ FIXED: Top-level parameter
    }

    console.log('[AIGateway] Request body:', JSON.stringify(body, null, 2));

    try {
      const response = await fetch(`${this.openaiBaseURL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openaiKey}`,
          'Content-Type': 'application/json',
          'cf-aig-authorization': `Bearer ${this.aiGatewayToken}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AIGateway] OpenAI API Error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          request_model: request.model,
          request_max_tokens: request.max_tokens
        });
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();
      console.log('[AIGateway] Response received:', {
        model: data.model,
        usage: data.usage,
        has_tool_calls: !!data.choices[0]?.message?.tool_calls
      });

      // Extract tool call result
      const toolCall = data.choices[0]?.message?.tool_calls?.[0];
      
      if (!toolCall) {
        console.error('[AIGateway] No tool call in response:', {
          finish_reason: data.choices[0]?.finish_reason,
          message: data.choices[0]?.message
        });
        throw new Error('GPT-5 did not return structured output via tool call');
      }

      // Parse the tool call arguments
      let parsedContent: any;
      try {
        parsedContent = JSON.parse(toolCall.function.arguments);
      } catch (parseError: any) {
        console.error('[AIGateway] Failed to parse tool call arguments:', {
          arguments: toolCall.function.arguments,
          error: parseError.message
        });
        throw new Error(`Failed to parse structured output: ${parseError.message}`);
      }

      // Calculate cost
      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const totalCost = calculateAICost(
        request.model,
        usage.prompt_tokens,
        usage.completion_tokens
      );

      console.log('[AIGateway] Structured call complete:', {
        tokens_in: usage.prompt_tokens,
        tokens_out: usage.completion_tokens,
        cost: totalCost,
        content_keys: Object.keys(parsedContent)
      });

      return {
        content: parsedContent,
        usage: {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_cost: totalCost
        },
        model_used: request.model,
        provider: 'openai'
      };

    } catch (error: any) {
      console.error('[AIGateway] Structured call failed:', {
        error_name: error.name,
        error_message: error.message,
        model: request.model
      });
      throw error;
    }
  }

  // ===============================================================================
  // PRIVATE METHODS - PROVIDER SPECIFIC
  // ===============================================================================

  /**
   * OpenAI API call via AI Gateway (Chat Completions API)
   */
  private async callOpenAI(request: AIRequest, pricing: any): Promise<AIResponse> {
    console.log('[AIGateway] OpenAI call starting:', {
      model: request.model,
      max_tokens: request.max_tokens,
      reasoning_effort: request.reasoning_effort,
      has_json_schema: !!request.json_schema
    });

    const body: any = {
      model: request.model,
      messages: [
        { role: 'system', content: request.system_prompt },
        { role: 'user', content: request.user_prompt }
      ],
      max_completion_tokens: request.max_tokens // ✅ FIXED: Correct parameter name
    };

    // Add optional parameters
    if (request.reasoning_effort) {
      body.reasoning_effort = request.reasoning_effort; // ✅ FIXED: Top-level parameter
    }

    // NOTE: GPT-5 reasoning models only support temperature: 1 (default)
    // Do not set temperature parameter - it will error on non-default values

    // Add JSON schema if supported and provided
    if (request.json_schema && pricing.supports_json_schema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: request.json_schema
      };
    }

    try {
      const response = await fetch(`${this.openaiBaseURL}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.openaiKey}`,
          'Content-Type': 'application/json',
          'cf-aig-authorization': `Bearer ${this.aiGatewayToken}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AIGateway] OpenAI API Error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          request_model: request.model
        });
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();

      const usage = data.usage || { prompt_tokens: 0, completion_tokens: 0 };
      const totalCost = calculateAICost(
        request.model,
        usage.prompt_tokens,
        usage.completion_tokens
      );

      const content = data.choices[0]?.message?.content || '';

      console.log('[AIGateway] OpenAI call complete:', {
        tokens_in: usage.prompt_tokens,
        tokens_out: usage.completion_tokens,
        cost: totalCost,
        content_length: content.length
      });

      return {
        content,
        usage: {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_cost: totalCost
        },
        model_used: request.model,
        provider: 'openai'
      };

    } catch (error: any) {
      console.error('[AIGateway] OpenAI call failed:', {
        error_name: error.name,
        error_message: error.message,
        model: request.model
      });
      throw error;
    }
  }

  /**
   * Claude API call via AI Gateway (Messages API)
   */
  private async callClaude(request: AIRequest, pricing: any): Promise<AIResponse> {
    console.log('[AIGateway] Claude call starting:', {
      model: request.model,
      max_tokens: request.max_tokens
    });

    const body = {
      model: request.model,
      system: request.system_prompt,
      messages: [
        { role: 'user', content: request.user_prompt }
      ],
      max_tokens: request.max_tokens, // Claude uses max_tokens (not max_completion_tokens)
      temperature: request.temperature ?? 0
    };

    try {
      const response = await fetch(`${this.claudeBaseURL}/v1/messages`, {
        method: 'POST',
        headers: {
          'x-api-key': this.claudeKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'cf-aig-authorization': `Bearer ${this.aiGatewayToken}`
        },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[AIGateway] Claude API Error:', {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
          request_model: request.model
        });
        throw new Error(`Claude API error (${response.status}): ${errorText}`);
      }

      const data = await response.json();

      const usage = data.usage || { input_tokens: 0, output_tokens: 0 };
      const totalCost = calculateAICost(
        request.model,
        usage.input_tokens,
        usage.output_tokens
      );

      const content = data.content[0]?.text || '';

      console.log('[AIGateway] Claude call complete:', {
        tokens_in: usage.input_tokens,
        tokens_out: usage.output_tokens,
        cost: totalCost,
        content_length: content.length
      });

      return {
        content,
        usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          total_cost: totalCost
        },
        model_used: request.model,
        provider: 'anthropic'
      };

    } catch (error: any) {
      console.error('[AIGateway] Claude call failed:', {
        error_name: error.name,
        error_message: error.message,
        model: request.model
      });
      throw error;
    }
  }
}
