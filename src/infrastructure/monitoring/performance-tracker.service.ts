// infrastructure/monitoring/performance-tracker.service.ts

/**
 * PERFORMANCE TRACKER SERVICE
 * Tracks step durations to identify bottlenecks
 */

export interface PerformanceStep {
  name: string;
  start: number;
  end: number | null;
  duration_ms: number | null;
}

export interface PerformanceBreakdown {
  steps: Array<{
    step: string;
    duration_ms: number;
    percentage: number;
  }>;
  total_duration_ms: number;
  bottleneck: {
    step: string;
    duration_ms: number;
  };
}

export class PerformanceTracker {
  private steps: PerformanceStep[] = [];
  private startTime: number;

  constructor() {
    this.startTime = Date.now();
  }

  /**
   * Start tracking a step
   */
  startStep(name: string): void {
    this.steps.push({
      name,
      start: Date.now(),
      end: null,
      duration_ms: null
    });

    console.log(`[Performance] Step started: ${name}`);
  }

  /**
   * End tracking a step
   */
  endStep(name: string): void {
    const step = this.steps.find(s => s.name === name && s.end === null);
    
    if (step) {
      step.end = Date.now();
      step.duration_ms = step.end - step.start;

      console.log(`[Performance] Step completed: ${name} (${step.duration_ms}ms)`);
    } else {
      console.warn(`[Performance] Step not found or already ended: ${name}`);
    }
  }

  /**
   * Get performance breakdown
   */
  getBreakdown(): PerformanceBreakdown {
    const totalDuration = this.steps.reduce((sum, s) => sum + (s.duration_ms || 0), 0);
    
    const bottleneck = this.steps.reduce((max, s) =>
      (s.duration_ms || 0) > (max.duration_ms || 0) ? s : max
    );

    return {
      steps: this.steps.map(s => ({
        step: s.name,
        duration_ms: s.duration_ms || 0,
        percentage: totalDuration > 0 ? parseFloat((((s.duration_ms || 0) / totalDuration) * 100).toFixed(1)) : 0
      })),
      total_duration_ms: totalDuration,
      bottleneck: {
        step: bottleneck.name,
        duration_ms: bottleneck.duration_ms || 0
      }
    };
  }

  /**
   * Get total elapsed time since tracker creation
   */
  getTotalElapsed(): number {
    return Date.now() - this.startTime;
  }

  /**
   * Get summary for logging
   */
  getSummary(): string {
    const breakdown = this.getBreakdown();
    
    const stepsStr = breakdown.steps
      .map(s => `${s.step}: ${s.duration_ms}ms (${s.percentage}%)`)
      .join(', ');

    return `Performance: ${breakdown.total_duration_ms}ms total | Bottleneck: ${breakdown.bottleneck.step} (${breakdown.bottleneck.duration_ms}ms) | Steps: ${stepsStr}`;
  }

  /**
   * Export for database storage
   */
  exportForDatabase() {
    const breakdown = this.getBreakdown();

    return {
      total_duration_ms: breakdown.total_duration_ms,
      bottleneck_step: breakdown.bottleneck.step,
      bottleneck_duration_ms: breakdown.bottleneck.duration_ms,
      steps: breakdown.steps
    };
  }
}
