import { getApiKey } from './enhanced-config-manager.js';
import { logger } from '../utils/logger.js';

interface ModelConfig {
  name: string;
  provider: 'openai' | 'claude';
  intelligence: number;
  cost_per_1m_in: number;
  cost_per_1m_out: number;
  max_context: number;
  api_format: 'gpt5_responses' | 'gpt_chat' | 'claude_messages';
  backup?: string;
}

const MODEL_CONFIGS: Record<string, ModelConfig> = {
  'gpt-5': {
    name: 'gpt-5',
    provider: 'openai',
    intelligence: 96,
    cost_per_1m_in: 1.25,
    cost_per_1m_out: 10.00,
    max_context: 128000,
    api_format: 'gpt5_responses',
    backup: 'gpt-5-mini'
  },
  'gpt-5-mini': {
    name: 'gpt-5-mini',
    provider: 'openai',
    intelligence: 80,
    cost_per_1m_in: 0.25,
    cost_per_1m_out: 2.00,
    max_context: 64000,
    api_format: 'gpt5_responses'
  },
  'gpt-5-nano': {
    name: 'gpt-5-nano',
    provider: 'openai',
    intelligence: 64,
    cost_per_1m_in: 0.05,
    cost_per_1m_out: 0.40,
    max_context: 64000,
    api_format: 'gpt5_responses'
  }
};

const ANALYSIS_MAPPINGS: Record<string, string> = {
  triage: 'gpt-5-nano',
  preprocessor: 'gpt-5-nano', 
  light: 'gpt-5-nano',
  deep: 'gpt-5-mini',
  xray: 'gpt-5',
  context: 'gpt-5-mini'
};

export interface UniversalRequest {
  model_name: string;
  system_prompt: string;
  user_prompt: string;
  max_tokens: number;
  temperature?: number;
  json_schema?: any;
  response_format?: 'json' | 'text';
  analysis_type?: string;
}

export interface UniversalResponse {
  content: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_cost: number;
  };
  model_used: string;
  provider: string;
}

export class UniversalAIAdapter {
  private env: any;
  private requestId: string;

  constructor(env: any, requestId: string) {
    this.env = env;
    this.requestId = requestId;
  }

async executeRequest(request: UniversalRequest): Promise<UniversalResponse> {
    const modelConfig = MODEL_CONFIGS[request.model_name];
    if (!modelConfig) {
      throw new Error(`Unknown model: ${request.model_name}`);
    }

    // Log token usage for optimization tracking
    this.logTokenUsage(request.user_prompt, request.model_name, this.requestId);

    try {
      return await this.executeModelCall(modelConfig, request);
    } catch (error: any) {
      logger('warn', `Primary model ${request.model_name} failed, trying backup`, { 
        error: error.message,
        requestId: this.requestId 
      });

if (modelConfig.backup) {
        const backupConfig = MODEL_CONFIGS[modelConfig.backup];
        if (backupConfig) {
          return await this.executeModelCall(backupConfig, request);
        }
      }

      throw error;
    }
  }

  private estimateTokenCount(text: string): number {
    // Rough estimation: 4 characters = 1 token
    return Math.ceil(text.length / 4);
  }

  private logTokenUsage(prompt: string, modelName: string, requestId: string): void {
    const estimatedTokens = this.estimateTokenCount(prompt);
    logger('info', 'Token usage estimate', {
      model: modelName,
      estimated_input_tokens: estimatedTokens,
      prompt_length: prompt.length,
      requestId
    });
  }
  
private async executeModelCall(config: ModelConfig, request: UniversalRequest): Promise<UniversalResponse> {
  switch (config.api_format) {
    case 'gpt5_responses':
      return await this.callGPT5Responses(config, request);
    case 'gpt_chat':
      return await this.callGPTChat(config, request);
    case 'claude_messages':
      return await this.callClaudeMessages(config, request);
    default:
      throw new Error(`Unsupported API format: ${config.api_format}`);
  }
}


private async callGPT5Responses(config: ModelConfig, request: UniversalRequest): Promise<UniversalResponse> {
const openaiKey = await getApiKey('OPENAI_API_KEY', this.env, this.env.APP_ENV);
if (!openaiKey) throw new Error('OpenAI API key not available');

logger('info', '🚀 GPT-5 Request Starting', {
    model: config.name,
    max_tokens: request.max_tokens,
    has_json_schema: !!request.json_schema,
    response_format: request.response_format,
    temperature: request.temperature,
    requestId: this.requestId
  });

const body = {
  model: config.name,
  messages: [
    { role: 'system', content: request.system_prompt },
    { role: 'user', content: request.user_prompt }
  ],
  max_completion_tokens: request.max_tokens,
  // GPT-5 models don't support temperature parameter
  ...(request.temperature !== undefined && !config.name.includes('gpt-5') && {
    temperature: request.temperature
  }),
// Speed optimization for all GPT-5 models
  ...(config.name.includes('gpt-5') && {
    reasoning_effort: request.analysis_type === 'light' ? 'low' : 'medium'
  }),
  ...(request.json_schema && {
    response_format: {
      type: 'json_schema',
      json_schema: request.json_schema
    }
  })
};

  logger('info', '📤 GPT-5 Request Body', {
    model: body.model,
    max_completion_tokens: body.max_completion_tokens,
    reasoning_effort: body.reasoning_effort,
    has_temperature: 'temperature' in body,
    has_json_schema: !!body.response_format,
    requestId: this.requestId
  });

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${openaiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  logger('info', '📥 GPT-5 Response Status', {
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: Object.fromEntries(response.headers.entries()),
    requestId: this.requestId
  });

  if (!response.ok) {
    const errorBody = await response.text();
    logger('error', '❌ GPT-5 API Error Details', {
      status: response.status,
      statusText: response.statusText,
      errorBody: errorBody,
      requestId: this.requestId
    });
    throw new Error(`GPT-5 API error: ${response.status} - ${errorBody}`);
  }

const data = await response.json();
logger('info', '✅ GPT-5 Response Success', {
  has_choices: !!data.choices,
  choices_length: data.choices?.length,
  has_usage: !!data.usage,
  first_choice_content_length: data.choices?.[0]?.message?.content?.length,
  usage_tokens: data.usage,
  full_response_structure: JSON.stringify(data, null, 2), // ✅ LOG FULL RESPONSE
  requestId: this.requestId
});

const content = data.choices?.[0]?.message?.content || '';
logger('info', '🔍 GPT-5 Content Extraction', {
  content_extracted: content,
  content_length: content.length,
  has_message: !!data.choices?.[0]?.message,
  message_keys: data.choices?.[0]?.message ? Object.keys(data.choices[0].message) : [],
  requestId: this.requestId
});
  const usage = data.usage || {};

  return {
    content,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_cost: this.calculateCost(usage.prompt_tokens || 0, usage.completion_tokens || 0, config)
    },
    model_used: config.name,
    provider: config.provider
  };
}

  private async callClaudeMessages(config: ModelConfig, request: UniversalRequest): Promise<UniversalResponse> {
const claudeKey = await getApiKey('CLAUDE_API_KEY', this.env, this.env.APP_ENV);
if (!claudeKey) throw new Error('Claude API key not available');

const body = {
  model: config.name,
  system: `${request.system_prompt}\n\nIMPORTANT: Return only raw JSON without markdown formatting, code blocks, or backticks. Start your response directly with { and end with }.`,
  messages: [
    { role: 'user', content: request.user_prompt }
  ],
  max_tokens: request.max_tokens
};

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': claudeKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`Claude API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || '';
    const usage = data.usage || {};

    return {
      content,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
        total_cost: this.calculateCost(usage.input_tokens || 0, usage.output_tokens || 0, config)
      },
      model_used: config.name,
      provider: config.provider
    };
  }

private calculateCost(inputTokens: number, outputTokens: number, config: ModelConfig): number {
  const inputCost = (inputTokens / 1000000) * config.cost_per_1m_in;
  const outputCost = (outputTokens / 1000000) * config.cost_per_1m_out;
  return inputCost + outputCost;
}
}

export function selectModel(stage: string): string {
  return ANALYSIS_MAPPINGS[stage] || 'gpt-5-nano';
}
