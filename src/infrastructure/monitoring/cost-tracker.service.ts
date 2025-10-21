// infrastructure/monitoring/cost-tracker.service.ts

/**
 * COST TRACKER SERVICE
 * Tracks all costs per analysis: Apify + AI calls
 * Calculates profit margins based on credit pricing
 */

export interface CostBreakdown {
  apify_cost: number;
  ai_calls: AICallCost[];
  total_ai_cost: number;
  total_cost: number;
  cost_by_provider: {
    apify: number;
    openai: number;
    anthropic: number;
  };
}

export interface AICallCost {
  model: string;
  provider: 'openai' | 'anthropic';
  tokens_in: number;
  tokens_out: number;
  cost: number;
  duration_ms: number;
  call_type: string;  // 'core_analysis', 'outreach', 'personality', etc.
}

export interface MarginAnalysis {
  revenue: number;           // Credits charged × $0.97
  total_cost: number;        // All expenses
  gross_profit: number;      // Revenue - Cost
  margin_percentage: number; // (Profit / Revenue) × 100
  roi: number;              // (Profit / Cost) × 100
}

export class CostTracker {
  private apifyCost: number = 0;
  private aiCalls: AICallCost[] = [];

  /**
   * Track Apify scraping cost
   */
  trackApify(durationMs: number, cost: number): void {
    this.apifyCost = cost;
    
    console.log('[Cost] Apify tracked', {
      duration_ms: durationMs,
      cost: cost.toFixed(6)
    });
  }

  /**
   * Track AI call cost
   */
  trackAICall(
    model: string,
    provider: 'openai' | 'anthropic',
    tokensIn: number,
    tokensOut: number,
    cost: number,
    durationMs: number,
    callType: string
  ): void {
    const call: AICallCost = {
      model,
      provider,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost,
      duration_ms: durationMs,
      call_type: callType
    };

    this.aiCalls.push(call);

    console.log('[Cost] AI call tracked', {
      model,
      call_type: callType,
      tokens: `${tokensIn}→${tokensOut}`,
      cost: cost.toFixed(6)
    });
  }

  /**
   * Get complete cost breakdown
   */
  getBreakdown(): CostBreakdown {
    const totalAICost = this.aiCalls.reduce((sum, call) => sum + call.cost, 0);
    
    const openaiCost = this.aiCalls
      .filter(c => c.provider === 'openai')
      .reduce((sum, c) => sum + c.cost, 0);
    
    const anthropicCost = this.aiCalls
      .filter(c => c.provider === 'anthropic')
      .reduce((sum, c) => sum + c.cost, 0);

    return {
      apify_cost: this.apifyCost,
      ai_calls: this.aiCalls,
      total_ai_cost: totalAICost,
      total_cost: this.apifyCost + totalAICost,
      cost_by_provider: {
        apify: this.apifyCost,
        openai: openaiCost,
        anthropic: anthropicCost
      }
    };
  }

  /**
   * Calculate profit margins
   */
  calculateMargin(creditsUsed: number): MarginAnalysis {
    const CREDIT_PRICE = 0.97;  // $0.97 per credit
    
    const breakdown = this.getBreakdown();
    const revenue = creditsUsed * CREDIT_PRICE;
    const totalCost = breakdown.total_cost;
    const grossProfit = revenue - totalCost;
    const marginPercentage = revenue > 0 ? (grossProfit / revenue) * 100 : 0;
    const roi = totalCost > 0 ? (grossProfit / totalCost) * 100 : 0;

    return {
      revenue,
      total_cost: totalCost,
      gross_profit: grossProfit,
      margin_percentage: parseFloat(marginPercentage.toFixed(2)),
      roi: parseFloat(roi.toFixed(2))
    };
  }

  /**
   * Get summary for logging
   */
  getSummary(creditsUsed: number): string {
    const breakdown = this.getBreakdown();
    const margin = this.calculateMargin(creditsUsed);

    return `Cost Summary: $${breakdown.total_cost.toFixed(4)} (Apify: $${breakdown.apify_cost.toFixed(4)}, AI: $${breakdown.total_ai_cost.toFixed(4)}) | Revenue: $${margin.revenue.toFixed(2)} | Profit: $${margin.gross_profit.toFixed(4)} (${margin.margin_percentage}%)`;
  }

  /**
   * Export for database storage
   */
  exportForDatabase() {
    const breakdown = this.getBreakdown();

    return {
      apify_cost: breakdown.apify_cost,
      total_ai_cost: breakdown.total_ai_cost,
      total_cost: breakdown.total_cost,
      ai_calls: this.aiCalls.map(call => ({
        model: call.model,
        provider: call.provider,
        tokens_in: call.tokens_in,
        tokens_out: call.tokens_out,
        cost: call.cost,
        call_type: call.call_type
      })),
      cost_by_provider: breakdown.cost_by_provider
    };
  }
}
