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
