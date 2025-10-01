// ===============================================================================
// ENVIRONMENT INTERFACE (UPDATED)
// ===============================================================================
export interface Env {
  // AWS Credentials (Cloudflare secrets)
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  AWS_REGION: string;
  
  // Environment identifier (Cloudflare var, not secret)
  APP_ENV: string;
  
  // Cloudflare bindings
  OSLIRA_KV: KVNamespace;
  R2_CACHE_BUCKET: R2Bucket;
  
  // ALL other secrets retrieved from AWS Secrets Manager at runtime
}

// ===============================================================================
// PROFILE AND ANALYSIS INTERFACES (UPDATED)
// ===============================================================================

export interface ProfileData {
  username: string;
  displayName: string;
  bio: string;
  followersCount: number;
  followingCount: number;
  postsCount: number;
  isVerified: boolean;
  isPrivate: boolean;
  profilePicUrl: string;
  externalUrl: string;
  isBusinessAccount?: boolean;
  latestPosts: PostData[];
  engagement?: EngagementData;
  scraperUsed?: string;
  dataQuality?: 'high' | 'medium' | 'low';
}

export interface PostData {
  id: string;
  shortCode: string;
  caption: string;
  likesCount: number;
  commentsCount: number;
  timestamp: string;
  url: string;
  type: string;
  hashtags: string[];
  mentions: string[];
  viewCount?: number;
  isVideo?: boolean;
}

export interface EngagementData {
  avgLikes: number;
  avgComments: number;
  engagementRate: number;
  totalEngagement: number;
  postsAnalyzed: number;
  qualityScore?: number;
}

export interface BusinessProfile {
  id: string;
  user_id: string;
  name: string;
  industry: string;
  target_audience: string;
  value_proposition: string;
  pain_points: string[];
  unique_advantages: string[];
  website: string;
  created_at: string;
}

// Updated AnalysisResult to match new schema field names
export interface AnalysisResult {
  score: number;           // Maps to runs.overall_score
  engagement_score: number; // Maps to runs.engagement_score
  niche_fit: number;       // Maps to runs.niche_fit_score
  audience_quality: string;
  engagement_insights: string;
  selling_points: string[];
  reasons: string[];
  quick_summary?: string;   // Maps to runs.summary_text
  deep_summary?: string;    // Goes to payload
  confidence_level?: number; // Maps to runs.confidence_level
  outreach_message?: string; // Goes to payload
}

export interface AnalysisRequest {
  profile_url?: string;
  username?: string;
  analysis_type: AnalysisType;
  type?: AnalysisType; // Backward compatibility
  business_id: string;
  user_id: string;
}

export type AnalysisType = 'light' | 'deep' | 'xray';

export interface User {
  id: string;
  email: string;
  full_name: string;
  credits: number;
  subscription_status: string;
  created_at: string;
  last_login: string;
  subscription_id: string;
  stripe_customer_id: string;
}

// ===============================================================================
// DATABASE RESPONSE INTERFACES
// ===============================================================================

export interface DashboardLead {
  lead_id: string;
  username: string;
  display_name?: string;
  profile_picture_url?: string;
  follower_count: number;
  is_verified_account: boolean;
  runs: DashboardRun[];
}

export interface DashboardRun {
  run_id: string;
  analysis_type: AnalysisType;
  overall_score: number;
  niche_fit_score: number;
  engagement_score: number;
  summary_text?: string;
  confidence_level?: number;
  created_at: string;
}

export interface AnalysisDetails {
  // Run data
  run_id: string;
  analysis_type: AnalysisType;
  overall_score: number;
  niche_fit_score: number;
  engagement_score: number;
  summary_text?: string;
  confidence_level?: number;
  ai_model_used?: string;
  created_at: string;
  
  // Lead data
  leads: {
    username: string;
    display_name?: string;
    profile_picture_url?: string;
    bio_text?: string;
    follower_count: number;
    following_count: number;
    is_verified_account: boolean;
  };
  
  // Payload data (optional)
  payloads?: {
    analysis_data: LightPayload | DeepPayload | XRayPayload;
  }[];
}

// ===============================================================================
// API RESPONSE INTERFACES
// ===============================================================================

export interface StandardResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  requestId?: string;
  timestamp: string;
}

export interface AnalysisResponse {
  run_id: string;
  profile: {
    username: string;
    displayName: string;
    followersCount: number;
    isVerified: boolean;
    profilePicUrl: string;
    dataQuality: string;
    scraperUsed: string;
  };
  analysis: {
    overall_score: number;
    niche_fit_score: number;
    engagement_score: number;
    type: AnalysisType;
    confidence_level?: number;
    summary_text?: string;
    // Deep analysis fields
    audience_quality?: string;
    selling_points?: string[];
    reasons?: string[];
    deep_summary?: string;
    outreach_message?: string;
    engagement_breakdown?: {
      avg_likes: number;
      avg_comments: number;
      engagement_rate: number;
      posts_analyzed: number;
      data_source: string;
    };
    // X-Ray analysis fields
    copywriter_profile?: any;
    commercial_intelligence?: any;
    persuasion_strategy?: any;
  };
  credits: {
    used: number;
    remaining: number;
  };
  metadata: {
    request_id: string;
    analysis_completed_at: string;
    schema_version: string;
  };
}

// ===============================================================================
// ANALYTICS INTERFACES
// ===============================================================================

export interface AnalyticsSummary {
  success: boolean;
  summary: {
    totalAnalyses: number;
    uniqueLeads: number;
    averageOverallScore: number;
    averageNicheFitScore: number;
    averageEngagementScore: number;
    conversionRate: string;
    avgEngagementRate: string;
    recentActivity: number;
    monthlyActivity: number;
    activeUsers: number;
    totalCreditsAvailable: number;
    analysisBreakdown: {
      light: number;
      deep: number;
      xray: number;
    };
  };
  trends: {
    analysesGrowth: string;
    scoreImprovement: string;
    engagementTrend: string;
    userGrowth: string;
  };
  insights: {
    topPerformingScore: number;
    mostActiveWeek: string;
    recommendedFocus: string;
    engagementBenchmark: string;
  };
}

export interface EnhancedAnalytics {
  success: boolean;
  performance: {
    overall_score: number;
    niche_fit: number;
    engagement: number;
    engagement_rate: number;
    success_rate: number;
    trend_direction: string;
  };
  segmentation: {
    high_performers: number;
    medium_performers: number;
    low_performers: number;
    micro_influencers: number;
    macro_influencers: number;
  };
  analysis_breakdown: {
    total_analyses: number;
    light: number;
    deep: number;
    xray: number;
    deep_analysis_ratio: number;
  };
  insights: string[];
  recommendations: string[];
  metrics: {
    avg_followers: number;
    recent_performance: number;
    total_leads: number;
    analyses_this_week: number;
  };
}

// ===============================================================================
// VALIDATION INTERFACES
// ===============================================================================

export interface ValidationResult {
  isValid: boolean;
  error?: string;
  normalizedData?: any;
}

export interface UserValidationResult {
  isValid: boolean;
  error?: string;
  credits?: number;
  userId?: string;
}

// ===============================================================================
// CREDIT TRANSACTION INTERFACE
// ===============================================================================

export interface CreditTransaction {
  id: string;
  user_id: string;
  amount: number;
  type: 'use' | 'purchase' | 'refund' | 'bonus';
  description: string;
  run_id: string; // REQUIRED - no legacy lead_id support
  created_at: string;
}

// ===============================================================================
// BULK ANALYSIS INTERFACES
// ===============================================================================

export interface BulkAnalysisRequest {
  profiles: string[]; // Array of usernames or URLs
  analysis_type: AnalysisType;
  business_id: string;
  user_id: string;
}

export interface BulkAnalysisResult {
  total_requested: number;
  successful: number;
  failed: number;
  results: AnalysisResponse[];
  errors: Array<{
    profile: string;
    error: string;
  }>;
  credits_used: number;
  credits_remaining: number;
}


// ===============================================================================
// EXPORT ALL TYPES
// ===============================================================================

export type {
  LeadRecord,
  RunRecord,
  PayloadRecord,
  LightPayload,
  DeepPayload,
  XRayPayload,
  ProfileData,
  PostData,
  EngagementData,
  AnalysisResult,
  AnalysisRequest,
  AnalysisType,
  User,
  BusinessProfile,
  StandardResponse,
  AnalysisResponse,
  DashboardLead,
  DashboardRun,
  AnalysisDetails,
  AnalyticsSummary,
  EnhancedAnalytics,
  ValidationResult,
  UserValidationResult,
  CreditTransaction,
  BulkAnalysisRequest,
  BulkAnalysisResult,
  LegacyLeadData,
  LegacyAnalysisData,
  ProfileIntelligence,
  AnalysisTier,
  Env
};
