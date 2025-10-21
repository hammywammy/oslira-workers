// Environment interface for Cloudflare Worker
export interface Env {
  // AWS Credentials (from wrangler secrets)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  
  // Environment
  APP_ENV: 'production' | 'staging';
  
  // Cloudflare Bindings
  ANALYTICS_ENGINE: AnalyticsEngineDataset;
  
  // KV and R2 (accessed via code, not wrangler.toml)
  OSLIRA_KV?: KVNamespace;
  R2_CACHE_BUCKET?: R2Bucket;
}

// Analytics Engine types
export interface AnalyticsEngineDataset {
  writeDataPoint(event: AnalyticsEngineDataPoint): void;
}

export interface AnalyticsEngineDataPoint {
  blobs?: string[];
  doubles?: number[];
  indexes?: string[];
}
