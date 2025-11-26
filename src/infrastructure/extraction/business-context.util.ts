// infrastructure/extraction/business-context.util.ts

/**
 * BUSINESS CONTEXT UTILITY
 *
 * Fetches and transforms business profile data for AI lead analysis.
 * Maps database fields to the BusinessContext type used by the lead analysis service.
 *
 * Database fields mapped:
 * - business_name -> businessName
 * - business_context.business_summary -> valueProposition
 * - business_context.target_description -> targetAudience
 * - ideal_customer_profile.business_description -> industry (parsed)
 * - business_context.target_company_sizes -> painPoints (derived)
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '@/shared/utils/logger.util';
import { formatCount } from '@/shared/utils/number-format.util';
import type { BusinessContext } from './extraction.types';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Raw business profile from database
 */
interface BusinessProfileRow {
  id: string;
  business_name: string;
  business_context: {
    business_summary?: string;
    communication_tone?: string;
    target_description?: string;
    icp_min_followers?: number;
    icp_max_followers?: number;
    target_company_sizes?: string[];
  } | null;
  ideal_customer_profile: {
    business_description?: string;
    target_audience?: string;
    brand_voice?: string;
  } | null;
}

export interface FetchBusinessContextResult {
  success: true;
  data: BusinessContext;
}

export interface FetchBusinessContextError {
  success: false;
  error: {
    code: 'NOT_FOUND' | 'FETCH_ERROR' | 'INVALID_DATA';
    message: string;
  };
}

export type FetchBusinessContextOutput = FetchBusinessContextResult | FetchBusinessContextError;

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Fetch business context by business profile ID
 */
export async function fetchBusinessContext(
  supabase: SupabaseClient,
  businessProfileId: string
): Promise<FetchBusinessContextOutput> {
  logger.debug('[BusinessContext] Fetching business context', {
    businessProfileId
  });

  try {
    const { data, error } = await supabase
      .from('business_profiles')
      .select('id, business_name, business_context, ideal_customer_profile')
      .eq('id', businessProfileId)
      .is('deleted_at', null)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        logger.warn('[BusinessContext] Business profile not found', {
          businessProfileId
        });
        return {
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: `Business profile not found: ${businessProfileId}`
          }
        };
      }

      logger.error('[BusinessContext] Database error', {
        businessProfileId,
        error: error.message,
        code: error.code
      });

      return {
        success: false,
        error: {
          code: 'FETCH_ERROR',
          message: error.message
        }
      };
    }

    if (!data) {
      return {
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: `Business profile not found: ${businessProfileId}`
        }
      };
    }

    // Transform to BusinessContext
    const businessContext = transformToBusinessContext(data as BusinessProfileRow);

    logger.info('[BusinessContext] Business context fetched successfully', {
      businessProfileId,
      businessName: businessContext.businessName
    });

    return {
      success: true,
      data: businessContext
    };

  } catch (err: any) {
    logger.error('[BusinessContext] Unexpected error', {
      businessProfileId,
      error: err.message
    });

    return {
      success: false,
      error: {
        code: 'FETCH_ERROR',
        message: err.message
      }
    };
  }
}

// ============================================================================
// TRANSFORMATION
// ============================================================================

/**
 * Transform database row to BusinessContext
 */
function transformToBusinessContext(row: BusinessProfileRow): BusinessContext {
  const bc = row.business_context || {};
  const icp = row.ideal_customer_profile || {};

  // Extract industry from business description (best effort)
  const industry = extractIndustry(
    bc.business_summary || icp.business_description || ''
  );

  // Derive pain points from context
  const painPoints = derivePainPoints(bc, icp);

  // Extract ICP follower range with proper defaults
  // Use nullish coalescing (??) to properly handle 0 values
  const icpMinFollowers = bc.icp_min_followers ?? 0;
  const icpMaxFollowers = bc.icp_max_followers ?? null;

  return {
    businessName: row.business_name || 'Unknown Business',
    industry: industry,
    targetAudience: bc.target_description || icp.target_audience || 'Not specified',
    valueProposition: bc.business_summary || icp.business_description || 'Not specified',
    painPoints: painPoints,
    icpMinFollowers: icpMinFollowers,
    icpMaxFollowers: icpMaxFollowers
  };
}

/**
 * Extract industry from business description
 * Uses keyword matching for common industries
 */
function extractIndustry(description: string): string {
  const lowered = description.toLowerCase();

  // Industry keyword mappings
  const industries: Record<string, string[]> = {
    'Marketing & Social Media': ['marketing', 'social media', 'content', 'brand', 'influencer', 'digital marketing'],
    'E-commerce & Retail': ['ecommerce', 'e-commerce', 'retail', 'shop', 'store', 'product', 'selling'],
    'Health & Fitness': ['fitness', 'gym', 'health', 'wellness', 'personal trainer', 'nutrition', 'yoga'],
    'Beauty & Cosmetics': ['beauty', 'cosmetic', 'skincare', 'makeup', 'salon', 'hair'],
    'Food & Restaurant': ['food', 'restaurant', 'cafe', 'catering', 'chef', 'bakery', 'culinary'],
    'Real Estate': ['real estate', 'property', 'realtor', 'homes', 'apartments'],
    'Finance & Business': ['finance', 'business', 'consulting', 'coaching', 'entrepreneur', 'startup'],
    'Education & Coaching': ['education', 'coaching', 'teaching', 'course', 'training', 'mentor'],
    'Photography & Creative': ['photography', 'creative', 'design', 'art', 'videography', 'visual'],
    'Technology': ['tech', 'software', 'app', 'saas', 'digital', 'ai', 'automation']
  };

  for (const [industry, keywords] of Object.entries(industries)) {
    if (keywords.some(keyword => lowered.includes(keyword))) {
      return industry;
    }
  }

  return 'General Business';
}

/**
 * Derive pain points from business context
 * These represent common challenges the business helps solve
 */
function derivePainPoints(
  bc: BusinessProfileRow['business_context'],
  icp: BusinessProfileRow['ideal_customer_profile']
): string[] {
  const painPoints: string[] = [];

  // Default pain points based on social media marketing context
  painPoints.push('Growing Instagram following organically');
  painPoints.push('Creating engaging content consistently');
  painPoints.push('Converting followers to customers');

  // Add audience-size specific pain points
  if (bc?.icp_min_followers && bc?.icp_max_followers) {
    if (bc.icp_max_followers < 10000) {
      painPoints.push('Building initial audience and credibility');
    } else if (bc.icp_max_followers < 50000) {
      painPoints.push('Scaling engagement while growing');
    } else {
      painPoints.push('Maintaining engagement at scale');
    }
  }

  // Add tone-specific pain points
  if (bc?.communication_tone) {
    const tone = bc.communication_tone.toLowerCase();
    if (tone.includes('professional')) {
      painPoints.push('Establishing thought leadership');
    } else if (tone.includes('friendly') || tone.includes('casual')) {
      painPoints.push('Building authentic community connections');
    }
  }

  return painPoints.slice(0, 5); // Limit to 5 pain points
}

// Export is already done via the function declaration above
