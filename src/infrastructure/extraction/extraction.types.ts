// infrastructure/extraction/extraction.types.ts

/**
 * COMPREHENSIVE INSTAGRAM PROFILE EXTRACTION TYPES
 *
 * Extended types that capture the full Apify Instagram scraper response.
 * These types are more detailed than the simplified ProfileData types
 * used elsewhere in the system, enabling comprehensive metric calculation.
 */

// ============================================================================
// APIFY RAW INPUT TYPES (What Apify returns)
// ============================================================================

/**
 * External link from profile (business accounts can have multiple)
 */
export interface ApifyExternalLink {
  title: string;
  url: string;
}

/**
 * Full post data from Apify Instagram scraper
 * Includes all fields needed for comprehensive analysis
 */
export interface ApifyFullPost {
  id: string;
  shortCode: string;
  caption: string | null;
  likesCount: number;
  commentsCount: number;
  timestamp: string; // ISO 8601 format
  type: 'Image' | 'Video' | 'Sidecar';
  productType?: 'feed' | 'clips' | 'igtv'; // 'clips' = Reels
  displayUrl: string;
  videoUrl?: string;
  videoViewCount?: number;
  videoDuration?: number;

  // Content metadata
  hashtags: string[];
  mentions: string[];
  taggedUsers: ApifyTaggedUser[];
  locationName: string | null;
  locationId: string | null;

  // Accessibility
  alt: string | null;

  // Engagement settings
  isCommentsDisabled: boolean;
  isPinned?: boolean;

  // Carousel specifics
  childPosts?: ApifyChildPost[];
}

/**
 * Tagged user in a post
 */
export interface ApifyTaggedUser {
  id: string;
  username: string;
  fullName?: string;
}

/**
 * Child post in a carousel (Sidecar)
 */
export interface ApifyChildPost {
  id: string;
  type: 'Image' | 'Video';
  displayUrl: string;
  videoUrl?: string;
}

/**
 * Full profile data from Apify Instagram scraper
 * Extended version with all available fields
 */
export interface ApifyFullProfile {
  // Core identifiers
  id: string;
  username: string;
  fullName: string;

  // Profile content
  biography: string;
  bioLinks?: ApifyExternalLink[];
  externalUrl: string | null;
  externalUrls?: ApifyExternalLink[];
  profilePicUrl: string;
  profilePicUrlHD?: string;

  // Counts
  followersCount: number;
  followsCount: number;
  postsCount: number;
  igtvVideoCount?: number;
  highlightReelCount?: number;

  // Flags
  verified: boolean;
  private: boolean;
  isBusinessAccount: boolean;
  hasChannel?: boolean;

  // Business info
  businessCategoryName: string | null;
  businessEmail?: string | null;
  businessPhone?: string | null;
  businessAddress?: string | null;

  // Posts array
  latestPosts: ApifyFullPost[];

  // Metadata
  scrapedAt?: string;
}

// ============================================================================
// VALIDATION OUTPUT TYPES
// ============================================================================

/**
 * Data availability flags - what can we calculate?
 */
export interface DataAvailabilityFlags {
  profileExists: boolean;
  isPrivate: boolean;
  hasProfileData: boolean;
  hasPosts: boolean;
  hasEngagementData: boolean;
  hasVideoData: boolean;
  hasBusinessData: boolean;
  hasExternalLinks: boolean;
  hasBio: boolean;
  hasTimestamps: boolean;
  hasHashtags: boolean;
  hasMentions: boolean;
  hasLocationData: boolean;
}

/**
 * Validation result with detailed reasoning
 */
export interface ValidationResult {
  isValid: boolean;
  flags: DataAvailabilityFlags;
  errors: ValidationError[];
  warnings: ValidationWarning[];
}

export interface ValidationError {
  code: 'PROFILE_NOT_FOUND' | 'PROFILE_PRIVATE' | 'NO_DATA';
  message: string;
  field?: string;
}

export interface ValidationWarning {
  code: string;
  message: string;
  field?: string;
}

// ============================================================================
// METRIC OUTPUT TYPES
// ============================================================================

/**
 * Profile-level metrics (Group 1 - Always calculable)
 */
export interface ProfileMetrics {
  followersCount: number;
  followsCount: number;
  postsCount: number;
  authorityRatio: number | null;
  isBusinessAccount: boolean;
  verified: boolean;
  hasChannel: boolean;
  businessCategoryName: string | null;
  hasExternalLink: boolean;
  externalUrl: string | null;
  externalLinksCount: number;
  highlightReelCount: number;
  igtvVideoCount: number;
  hasBio: boolean;
  bioLength: number;
  username: string;
}

/**
 * Engagement metrics (Group 2 - Requires posts)
 */
export interface EngagementMetrics {
  totalLikes: number | null;
  totalComments: number | null;
  totalEngagement: number | null;
  avgLikesPerPost: number | null;
  avgCommentsPerPost: number | null;
  avgEngagementPerPost: number | null;
  engagementRate: number | null;
  commentToLikeRatio: number | null;
  engagementStdDev: number | null;
  engagementConsistency: number | null;
  engagementRatePerPost: number[];
  _reason: string | null;
}

/**
 * Posting frequency metrics (Group 2 - Requires posts with timestamps)
 */
export interface FrequencyMetrics {
  oldestPostTimestamp: string | null;
  newestPostTimestamp: string | null;
  postingPeriodDays: number | null;
  postingFrequency: number | null; // posts per month
  daysSinceLastPost: number | null;
  avgDaysBetweenPosts: number | null;
  timeBetweenPostsDays: number[];
  postingConsistency: number | null;
  _reason: string | null;
}

/**
 * Content format metrics (Group 2 - Requires posts)
 */
export interface FormatMetrics {
  reelsCount: number;
  videoCount: number;
  imageCount: number;
  carouselCount: number;
  reelsRate: number | null;
  videoRate: number | null;
  imageRate: number | null;
  carouselRate: number | null;
  formatDiversity: number; // 1-4 scale
  dominantFormat: 'reels' | 'video' | 'image' | 'carousel' | 'mixed' | null;
  _reason: string | null;
}

/**
 * Content quality metrics (Group 2 - Requires posts)
 */
export interface ContentMetrics {
  totalHashtags: number;
  avgHashtagsPerPost: number | null;
  uniqueHashtagCount: number;
  hashtagDiversity: number | null; // unique/total ratio

  totalMentions: number;
  avgMentionsPerPost: number | null;
  uniqueMentionCount: number;

  totalCaptionLength: number;
  avgCaptionLength: number | null;
  maxCaptionLength: number;

  postsWithLocation: number;
  locationTaggingRate: number | null;

  postsWithAltText: number;
  altTextRate: number | null;

  postsWithCommentsDisabled: number;
  commentsDisabledRate: number | null;
  commentsEnabledRate: number | null;

  _reason: string | null;
}

/**
 * Video-specific metrics (Group 3)
 */
export interface VideoMetrics {
  videoPostCount: number;
  totalVideoViews: number | null;
  avgVideoViews: number | null;
  videoViewRate: number | null; // views / followers
  videoViewToLikeRatio: number | null;
  _reason: string | null;
}

/**
 * Risk and quality scores (Group 4)
 */
export interface RiskScores {
  fakeFollowerRiskScore: number | null;
  fakeFollowerWarnings: string[];
  _reason: string | null;
}

/**
 * Derived account metrics (Group 4)
 */
export interface DerivedMetrics {
  contentDensity: number | null;
  viralPostCount: number; // posts with 2x+ average engagement
  viralPostRate: number | null;
  _reason: string | null;
}

/**
 * Text data for AI analysis (Group 5)
 */
export interface TextDataForAI {
  biography: string;
  recentCaptions: string[];
  allHashtags: string[];
  uniqueHashtags: string[];
  hashtagFrequency: HashtagFrequency[];
  allMentions: string[];
  uniqueMentions: string[];
  externalLinkTitles: string[];
  locationNames: string[];
}

export interface HashtagFrequency {
  hashtag: string;
  count: number;
}

// ============================================================================
// METADATA TYPES
// ============================================================================

/**
 * Processing metadata
 */
export interface ExtractionMetadata {
  username: string;
  processedAt: string;
  processingTimeMs: number;
  samplePostCount: number;
  totalPostCount: number;
  dataCompleteness: number; // percentage 0-100
  metricsCalculated: number;
  metricsSkipped: number;
  skippedReasons: SkippedMetricReason[];
  extractionVersion: string;
  lowConfidenceWarning: boolean;
}

export interface SkippedMetricReason {
  metricGroup: string;
  reason: string;
  affectedMetrics: string[];
}

// ============================================================================
// COMPLETE EXTRACTION OUTPUT
// ============================================================================

/**
 * Complete extraction result - the main output type
 */
export interface ExtractionResult {
  validation: ValidationResult;
  metadata: ExtractionMetadata;
  profileMetrics: ProfileMetrics;
  engagementMetrics: EngagementMetrics;
  frequencyMetrics: FrequencyMetrics;
  formatMetrics: FormatMetrics;
  contentMetrics: ContentMetrics;
  videoMetrics: VideoMetrics;
  riskScores: RiskScores;
  derivedMetrics: DerivedMetrics;
  textDataForAI: TextDataForAI;
}

/**
 * Error result when extraction fails at validation stage
 */
export interface ExtractionError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, any>;
  };
  metadata: {
    username: string;
    processedAt: string;
    processingTimeMs: number;
  };
}

/**
 * Union type for extraction output
 */
export type ExtractionOutput =
  | { success: true; data: ExtractionResult }
  | ExtractionError;

// ============================================================================
// CALCULATED METRICS OUTPUT (Phase 2 - Score Calculation)
// ============================================================================

/**
 * Composite scores calculated from raw metrics (0-100 scale)
 */
export interface CompositeScores {
  /** Engagement health score combining rate, consistency, and comment ratio */
  engagementHealth: number;
  /** Content sophistication based on hashtags, captions, locations, and format diversity */
  contentSophistication: number;
  /** Account maturity based on posting consistency, highlights, and profile completeness */
  accountMaturity: number;
  /** Fake follower risk score (higher = more suspicious) */
  fakeFollowerRisk: number;
  /** Overall opportunity score (weighted combination of other scores) */
  opportunityScore: number;
}

/**
 * Gap detection flags - areas where the ICP has room for improvement
 */
export interface GapDetection {
  /** Low engagement rate (<1%) with decent followers (>1000) */
  engagementGap: boolean;
  /** Basic content strategy: low hashtags (<3 avg), short captions (<100 avg), no locations */
  contentGap: boolean;
  /** No external links despite business features */
  conversionGap: boolean;
  /** Not using Reels despite algorithm preference */
  platformGap: boolean;
}

/**
 * Flattened raw metrics for database storage
 * Contains all 52 metrics from the extraction result in a flat structure
 */
export interface RawMetricsFlat {
  // Profile metrics (16)
  followersCount: number;
  followsCount: number;
  postsCount: number;
  authorityRatio: number | null;
  isBusinessAccount: boolean;
  verified: boolean;
  hasChannel: boolean;
  businessCategoryName: string | null;
  hasExternalLink: boolean;
  externalUrl: string | null;
  externalLinksCount: number;
  highlightReelCount: number;
  igtvVideoCount: number;
  hasBio: boolean;
  bioLength: number;
  username: string;

  // Engagement metrics (11)
  totalLikes: number | null;
  totalComments: number | null;
  totalEngagement: number | null;
  avgLikesPerPost: number | null;
  avgCommentsPerPost: number | null;
  avgEngagementPerPost: number | null;
  engagementRate: number | null;
  commentToLikeRatio: number | null;
  engagementStdDev: number | null;
  engagementConsistency: number | null;
  engagementRatePerPost: number[];

  // Frequency metrics (8)
  oldestPostTimestamp: string | null;
  newestPostTimestamp: string | null;
  postingPeriodDays: number | null;
  postingFrequency: number | null;
  daysSinceLastPost: number | null;
  avgDaysBetweenPosts: number | null;
  timeBetweenPostsDays: number[];
  postingConsistency: number | null;

  // Format metrics (10)
  reelsCount: number;
  videoCount: number;
  imageCount: number;
  carouselCount: number;
  reelsRate: number | null;
  videoRate: number | null;
  imageRate: number | null;
  carouselRate: number | null;
  formatDiversity: number;
  dominantFormat: 'reels' | 'video' | 'image' | 'carousel' | 'mixed' | null;

  // Content metrics (17)
  totalHashtags: number;
  avgHashtagsPerPost: number | null;
  uniqueHashtagCount: number;
  hashtagDiversity: number | null;
  totalMentions: number;
  avgMentionsPerPost: number | null;
  uniqueMentionCount: number;
  totalCaptionLength: number;
  avgCaptionLength: number | null;
  maxCaptionLength: number;
  postsWithLocation: number;
  locationTaggingRate: number | null;
  postsWithAltText: number;
  altTextRate: number | null;
  postsWithCommentsDisabled: number;
  commentsDisabledRate: number | null;
  commentsEnabledRate: number | null;

  // Video metrics (5)
  videoPostCount: number;
  totalVideoViews: number | null;
  avgVideoViews: number | null;
  videoViewRate: number | null;
  videoViewToLikeRatio: number | null;

  // Risk scores (2)
  fakeFollowerRiskScore: number | null;
  fakeFollowerWarnings: string[];

  // Derived metrics (3)
  contentDensity: number | null;
  viralPostCount: number;
  viralPostRate: number | null;
}

/**
 * Complete calculated metrics for database storage (calculated_metrics JSONB column)
 */
export interface CalculatedMetrics {
  /** Schema version for backwards compatibility */
  version: '1.0';
  /** ISO timestamp when calculation was performed */
  calculatedAt: string;
  /** Number of posts analyzed */
  sampleSize: number;
  /** Flattened raw metrics */
  raw: RawMetricsFlat;
  /** Composite scores (0-100 scale) */
  scores: CompositeScores;
  /** Gap detection flags */
  gaps: GapDetection;
}

// ============================================================================
// AI LEAD ANALYSIS OUTPUT (Phase 2 - GPT-5 Analysis)
// ============================================================================

/**
 * Business context from business_profiles table
 * Fetched and passed to AI for personalized analysis
 */
export interface BusinessContext {
  businessName: string;
  industry: string;
  targetAudience: string;
  valueProposition: string;
  painPoints: string[];
}

/**
 * AI-generated lead analysis result
 * Output structure from GPT-5 analysis
 */
export interface AILeadAnalysis {
  /** Lead qualification tier */
  leadTier: 'hot' | 'warm' | 'cold';

  /** Confidence score for the analysis (0-100) */
  confidence: number;

  /** Brief summary of the ICP profile */
  summary: string;

  /** Key strengths identified in the ICP */
  strengths: string[];

  /** Areas where the ICP could improve */
  weaknesses: string[];

  /** Specific opportunities to pitch the business services */
  opportunities: string[];

  /** Personalized outreach hooks based on ICP's content */
  outreachHooks: string[];

  /** Recommended next actions for the business */
  recommendedActions: string[];

  /** Risk factors to consider */
  riskFactors: string[];

  /** Why this ICP is/isn't a good fit */
  fitReasoning: string;
}

/**
 * Complete AI response for database storage (ai_response JSONB column)
 */
export interface AIResponsePayload {
  /** Schema version for backwards compatibility */
  version: '1.0';
  /** ISO timestamp when analysis was performed */
  analyzedAt: string;
  /** AI model used for analysis */
  model: string;
  /** Token usage for cost tracking */
  tokenUsage: {
    input: number;
    output: number;
  };
  /** The actual analysis result */
  analysis: AILeadAnalysis;
}
