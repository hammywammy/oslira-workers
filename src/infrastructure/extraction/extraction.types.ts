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
 * External link with metadata from Apify
 */
export interface ExternalLinkInfo {
  url: string;
  title: string;
  linkType: string;
}

/**
 * Profile-level metrics (Group 1 - Always calculable)
 */
export interface ProfileMetrics {
  followersCount: number;
  followsCount: number;
  postsCount: number;
  /**
   * Raw authority ratio: followers / following
   * No cap, exact calculation for comparison/display.
   * Examples: 198,486 (highly authoritative), 10 (moderate), 0.5 (low)
   */
  authorityRatioRaw: number | null;
  /**
   * Normalized authority score (0-100) using logarithmic scaling.
   * Better differentiation between highly authoritative accounts.
   *
   * Formula: Math.min(100, Math.log10(rawRatio) * 25)
   * Examples:
   * - rawRatio = 198,486 → score = 100 (capped)
   * - rawRatio = 10,000 → score = 100
   * - rawRatio = 1,000 → score = 75
   * - rawRatio = 100 → score = 50
   * - rawRatio = 10 → score = 25
   * - rawRatio = 1 → score = 0
   */
  authorityRatio: number | null;
  isBusinessAccount: boolean;
  verified: boolean;
  hasChannel: boolean;
  businessCategoryName: string | null;
  hasExternalLink: boolean;
  externalUrl: string | null;
  /** Full array of external links with metadata */
  externalUrls: ExternalLinkInfo[];
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
 *
 * Format hierarchy:
 * - Reels: Videos with productType='clips' (short-form vertical videos)
 * - Videos: ALL video content (type='Video'), INCLUDES reels
 * - Non-Reels Videos: Traditional videos that are NOT reels (IGTV, regular videos)
 * - Images: Static single images (type='Image')
 * - Carousels: Multi-image/video posts (type='Sidecar')
 *
 * Note: reelsCount + nonReelsVideoCount = videoCount
 */
export interface FormatMetrics {
  /** Reels only (productType='clips') - short-form vertical videos */
  reelsCount: number;
  /** ALL videos including reels (type='Video') */
  videoCount: number;
  /** Non-reels videos only (traditional videos, IGTV) */
  nonReelsVideoCount: number;
  /** Static single images */
  imageCount: number;
  /** Multi-image/video carousel posts */
  carouselCount: number;
  reelsRate: number | null;
  videoRate: number | null;
  imageRate: number | null;
  carouselRate: number | null;
  /** Format diversity score (0-4): how many different formats are used */
  formatDiversity: number;
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
  /** Average caption length excluding empty captions */
  avgCaptionLengthNonEmpty: number | null;
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
  /**
   * Number of recent posts with 2x+ average engagement.
   * Based on the scraped sample (typically 12 posts), NOT full account history.
   *
   * Example: "1 of 12 recent posts viral" - NOT representative of overall viral rate.
   * Use this as a directional indicator, not a statistically significant metric.
   */
  recentViralPostCount: number;
  /** Number of posts sampled for viral detection */
  recentPostsSampled: number;
  /**
   * @deprecated Renamed to make sample size clearer.
   * Percentage is misleading with small sample sizes.
   * Use recentViralPostCount and recentPostsSampled instead.
   */
  viralPostRate: number | null;
  _reason: string | null;
}

/**
 * Text data for AI analysis (Group 5)
 */
export interface TextDataForAI {
  biography: string;
  recentCaptions: string[];
  /** All hashtags (with duplicates, cleaned of punctuation) */
  allHashtags: string[];
  /** Unique hashtags (deduplicated) */
  uniqueHashtags: string[];
  /** Total count of hashtags (including duplicates) */
  totalHashtagsCount: number;
  /** Unique hashtag count for quick access */
  uniqueHashtagsCount: number;
  /** Top hashtags with frequency counts (top 10, sorted by count desc) */
  hashtagFrequency: HashtagFrequency[];
  allMentions: string[];
  uniqueMentions: string[];
  /** Top mentioned usernames with frequency counts (top 5) */
  topMentions: MentionFrequency[];
  externalLinkTitles: string[];
  locationNames: string[];
}

export interface HashtagFrequency {
  hashtag: string;
  count: number;
}

/**
 * Mention frequency data for AI analysis
 */
export interface MentionFrequency {
  username: string;
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
  dataCompleteness: number; // percentage 0-100 (capped)
  metricsCalculated: number;
  metricsSkipped: number;
  skippedReasons: SkippedMetricReason[];
  extractionVersion: string;
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
// EXTRACTED DATA OUTPUT (Lean, Actionable Insights)
// ============================================================================

/**
 * Extracted data for database storage (extracted_data JSONB column)
 *
 * Contains ONLY actionable signals for lead qualification:
 * - Is this lead warm?
 * - Is this account real?
 * - Is this worth contacting?
 *
 * Everything redundant (stored elsewhere) or vanity (not actionable) is removed.
 */
export interface ExtractedData {
  /** Schema version for backwards compatibility */
  version: '1.0';
  /** ISO timestamp when extraction was performed */
  extractedAt: string;
  /** Number of posts analyzed */
  sampleSize: number;

  // ========== ENGAGEMENT SIGNALS ==========
  /** Engagement rate (%) - key signal for account health */
  engagementScore: number | null;
  /** Engagement consistency (0-100) - indicates authentic engagement */
  engagementConsistency: number | null;

  // ========== RECENCY SIGNALS ==========
  /** Days since last post - indicates account activity */
  daysSinceLastPost: number | null;

  // ========== CONTENT SIGNALS ==========
  /** Top hashtags with frequency counts (top 10) - indicates content themes */
  topHashtags: HashtagFrequency[];
  /** Top mentioned usernames with frequency counts (top 5) - indicates partnerships */
  topMentions: MentionFrequency[];

  // ========== BUSINESS SIGNALS ==========
  /** Business category if account is a business account */
  businessCategoryName: string | null;

  // ========== RISK SIGNALS ==========
  /**
   * Soft warning about potential fake followers (not a hard numeric score)
   * Examples: "Some engagement patterns look inconsistent", "Account appears authentic", etc.
   */
  fakeFollowerWarning: string | null;
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
  /** ICP minimum follower count (defaults to 0 if not set) */
  icpMinFollowers: number;
  /** ICP maximum follower count (null means unlimited) */
  icpMaxFollowers: number | null;
}

/**
 * AI-generated lead analysis result
 * Output structure from GPT-5 analysis
 */
export interface AILeadAnalysis {
  /** Lead qualification tier */
  leadTier: 'hot' | 'warm' | 'cold';

  /** Key strengths identified in the ICP */
  strengths: string[];

  /** Areas where the ICP could improve */
  weaknesses: string[];

  /** Specific opportunities to pitch the business services */
  opportunities: string[];

  /** Recommended next actions for the business */
  recommendedActions: string[];

  /** Risk factors to consider */
  riskFactors: string[];

  /** Why this ICP is/isn't a good fit */
  fitReasoning: string;
}

/**
 * Complete AI response for database storage (ai_response JSONB column)
 * Note: analyzedAt, tokenUsage, and cost are tracked separately in the database
 */
export interface AIResponsePayload {
  /** Schema version for backwards compatibility */
  version: '1.0';
  /** AI model used for analysis */
  model: string;
  /** The actual analysis result */
  analysis: AILeadAnalysis;
}
