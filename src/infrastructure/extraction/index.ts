// infrastructure/extraction/index.ts

/**
 * PROFILE EXTRACTION MODULE
 *
 * Comprehensive Instagram profile data extraction and validation system.
 * Processes Apify Instagram scraper responses and calculates 70+ metrics.
 *
 * Usage:
 * ```typescript
 * import { createProfileExtractionService, ExtractionResult } from '@/infrastructure/extraction';
 *
 * const extractor = createProfileExtractionService();
 * const result = extractor.extract(apifyRawProfile);
 *
 * if (result.success) {
 *   console.log(result.data.engagementMetrics.engagementRate);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */

// Service
export {
  ProfileExtractionService,
  createProfileExtractionService
} from './profile-extraction.service';

// Types - Input
export type {
  ApifyExternalLink,
  ApifyFullPost,
  ApifyTaggedUser,
  ApifyChildPost,
  ApifyFullProfile
} from './extraction.types';

// Types - Validation
export type {
  DataAvailabilityFlags,
  ValidationResult,
  ValidationError,
  ValidationWarning
} from './extraction.types';

// Types - Metrics
export type {
  ProfileMetrics,
  EngagementMetrics,
  FrequencyMetrics,
  FormatMetrics,
  ContentMetrics,
  VideoMetrics,
  RiskScores,
  DerivedMetrics,
  TextDataForAI,
  HashtagFrequency
} from './extraction.types';

// Types - Output
export type {
  ExtractionMetadata,
  SkippedMetricReason,
  ExtractionResult,
  ExtractionError,
  ExtractionOutput
} from './extraction.types';

// Types - Extracted Data (Phase 2)
export type {
  ExtractedData
} from './extraction.types';

// Types - AI Analysis (Phase 2)
export type {
  BusinessContext,
  AILeadAnalysis,
  AIResponsePayload
} from './extraction.types';

// Services - Output Transformation (Phase 2)
export { transformToExtractedData } from './output-transformer.service';

// Services - Lead Analysis (Phase 2)
export {
  analyzeLeadWithAI,
  LEAD_ANALYSIS_MODEL,
  type LeadAnalysisInput,
  type LeadAnalysisResult,
  type LeadAnalysisError,
  type LeadAnalysisOutput
} from './lead-analysis.service';

// Utilities - Business Context (Phase 2)
export {
  fetchBusinessContext,
  type FetchBusinessContextResult,
  type FetchBusinessContextError,
  type FetchBusinessContextOutput
} from './business-context.util';
