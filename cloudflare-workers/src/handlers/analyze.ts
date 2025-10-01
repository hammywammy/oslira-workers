import { Context } from 'hono';
import type { Env, AnalysisRequest, ProfileData, AnalysisResponse } from '../types/interfaces.js';
import { generateRequestId, logger } from '../utils/logger.js';
import { createStandardResponse } from '../utils/response.js';
import { normalizeRequest } from '../utils/validation.js';
import { saveCompleteAnalysis, updateCreditsAndTransaction, fetchUserAndCredits, fetchBusinessProfile, getLeadIdFromRun } from '../services/database.js';

export async function handleAnalyze(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    logger('info', 'Analysis request received', { requestId });

    // Parse and validate request
    const body = await c.req.json() as AnalysisRequest;
    const { profile_url, username, analysis_type, business_id, user_id } = normalizeRequest(body);

    // Start all non-dependent operations in parallel
    const [userResult, business] = await Promise.all([
      fetchUserAndCredits(user_id, c.env),
      fetchBusinessProfile(business_id, user_id, c.env)
    ]);

    if (!userResult.isValid) {
      return c.json(createStandardResponse(false, undefined, userResult.error, requestId), 400);
    }

    // Check credit requirements
    const creditCost = analysis_type === 'deep' ? 2 : analysis_type === 'xray' ? 3 : 1;
    if (userResult.credits < creditCost) {
      return c.json(createStandardResponse(
        false, 
        undefined, 
        `Insufficient credits. Required: ${creditCost}, Available: ${userResult.credits}`, 
        requestId
      ), 400);
    }

    // Scrape profile with error handling
    let profileData: ProfileData;
    try {
      const { scrapeInstagramProfile } = await import('../services/instagram-scraper.js');
      profileData = await scrapeInstagramProfile(username, analysis_type, c.env);
      
      if (!profileData.username) {
        throw new Error('Profile scraping failed - no username returned');
      }
      
      logger('info', 'Profile scraping completed', { 
        username: profileData.username,
        followers: profileData.followersCount,
        dataQuality: profileData.dataQuality,
        requestId
      });
      
    } catch (scrapeError: any) {
      logger('error', 'Profile scraping failed', { error: scrapeError.message, requestId });
      return c.json(createStandardResponse(
        false, 
        undefined, 
        `Profile scraping failed: ${scrapeError.message}`, 
        requestId
      ), 400);
    }

    // Pre-screen for light analysis (early exit optimization)
    if (analysis_type === 'light') {
      const { preScreenProfile } = await import('../services/prompts.js');
      const preScreen = preScreenProfile(profileData, business);
      
      if (!preScreen.shouldProcess) {
        const earlyResult = {
          run_id: 'pre-screen-' + requestId,
          profile: {
            username: profileData.username,
            displayName: profileData.displayName,
            followersCount: profileData.followersCount,
            isVerified: profileData.isVerified,
            profilePicUrl: profileData.profilePicUrl,
            dataQuality: 'low',
            scraperUsed: profileData.scraperUsed || 'unknown'
          },
          analysis: {
            overall_score: preScreen.earlyScore || 0,
            niche_fit_score: 0,
            engagement_score: 0,
            type: analysis_type,
            confidence_level: 0.9,
            summary_text: preScreen.reason || 'Pre-screened as low quality',
            audience_quality: 'Low'
          },
          credits: { used: 0, remaining: userResult.credits },
          metadata: {
            request_id: requestId,
            analysis_completed_at: new Date().toISOString(),
            schema_version: '3.1',
            system_used: 'pre_screen'
          }
        };
        
        logger('info', 'Profile pre-screened - early exit', { 
          username: profileData.username,
          reason: preScreen.reason,
          score: preScreen.earlyScore
        });
        
        return c.json(createStandardResponse(true, earlyResult, undefined, requestId));
      }
    }
    
// DIRECT ANALYSIS - Single optimized system
    let analysisResult;
    let costDetails;
    let processingTime;
    
    try {
      logger('info', 'Executing direct analysis', { analysis_type, requestId });

      const { DirectAnalysisExecutor } = await import('../services/direct-analysis.js');
      const directExecutor = new DirectAnalysisExecutor(c.env, requestId);
      
      let directResult;
      switch (analysis_type) {
        case 'light':
          directResult = await directExecutor.executeLight(profileData, business);
          break;
        case 'deep':
          directResult = await directExecutor.executeDeep(profileData, business);
          break;
        case 'xray':
          directResult = await directExecutor.executeXRay(profileData, business);
          break;
        default:
          throw new Error(`Unsupported analysis type: ${analysis_type}`);
      }

      analysisResult = directResult.analysisData;
      costDetails = directResult.costDetails;
      processingTime = directResult.costDetails.processing_duration_ms;

    } catch (analysisError: any) {
      logger('error', 'Direct analysis failed', { 
        error: analysisError.message,
        analysis_type,
        requestId
      });
      return c.json(createStandardResponse(
        false, 
        undefined, 
        `Analysis failed: ${analysisError.message}`, 
        requestId
      ), 500);
    }

    // PREPARE DATA FOR DATABASE (3-TABLE STRUCTURE)
    const leadData = {
      user_id,
      business_id,
      username: profileData.username,
      full_name: profileData.displayName,
      profile_pic_url: profileData.profilePicUrl,
      bio: profileData.bio,
      external_url: profileData.externalUrl,
      followersCount: profileData.followersCount,
      followsCount: profileData.followingCount,
      postsCount: profileData.postsCount,
      is_verified: profileData.isVerified,
      is_private: profileData.isPrivate,
      is_business_account: profileData.isBusinessAccount || false,
      profile_url
    };

// SAVE TO DATABASE AND UPDATE CREDITS
    let run_id: string;
    let lead_id: string;
    try {
      // Step 1: Save analysis to database
      const saveResult = await saveCompleteAnalysis(leadData, analysisResult, analysis_type, c.env);
      run_id = saveResult.run_id;
      lead_id = saveResult.lead_id;
      
      logger('info', 'Database save successful', { 
        run_id,
        lead_id,
        username: profileData.username 
      });

      // Step 3: Update user credits with enhanced cost tracking
      const enhancedCostDetails = {
        actual_cost: costDetails.actual_cost,
        tokens_in: costDetails.tokens_in,
        tokens_out: costDetails.tokens_out,
        model_used: costDetails.model_used,
        block_type: costDetails.block_type,
        processing_duration_ms: processingTime,
        blocks_used: [costDetails.block_type]
      };

await updateCreditsAndTransaction(
  user_id, 
  creditCost, 
  analysis_type, 
  run_id,
  enhancedCostDetails,
  c.env
);

      logger('info', 'Credits updated successfully', { 
        user_id, 
        creditCost, 
        run_id,
        lead_id,
        actual_cost: costDetails.actual_cost,
        margin: creditCost - costDetails.actual_cost
      });

    } catch (saveError: any) {
      logger('error', 'Database save or credit update failed', { 
        error: saveError.message,
        username: profileData.username,
        requestId
      });
      return c.json(createStandardResponse(
        false, 
        undefined, 
        `Database operation failed: ${saveError.message}`,
        requestId
      ), 500);
    }

    // BUILD RESPONSE
    const responseData: AnalysisResponse = {
      run_id: run_id,
      profile: {
        username: profileData.username,
        displayName: profileData.displayName,
        followersCount: profileData.followersCount,
        isVerified: profileData.isVerified,
        profilePicUrl: profileData.profilePicUrl,
        dataQuality: profileData.dataQuality || 'medium',
        scraperUsed: profileData.scraperUsed || 'unknown'
      },
      analysis: {
        overall_score: analysisResult.score,
        niche_fit_score: analysisResult.niche_fit,
        engagement_score: analysisResult.engagement_score,
        type: analysis_type,
        confidence_level: analysisResult.confidence_level,
        summary_text: analysisResult.quick_summary,
        
        // Additional analysis fields based on type
        audience_quality: analysisResult.audience_quality,
        selling_points: analysisResult.selling_points || [],
        reasons: analysisResult.reasons || [],
        
        // Deep analysis fields
        ...(analysis_type === 'deep' && {
          deep_summary: analysisResult.deep_summary,
          outreach_message: analysisResult.outreach_message,
          engagement_breakdown: profileData.engagement ? {
            avg_likes: profileData.engagement.avgLikes,
            avg_comments: profileData.engagement.avgComments,
            engagement_rate: profileData.engagement.engagementRate,
            posts_analyzed: profileData.engagement.postsAnalyzed,
            data_source: 'real_scraped_calculation'
          } : null
        }),
        
        // X-Ray analysis fields
        ...(analysis_type === 'xray' && {
          copywriter_profile: analysisResult.copywriter_profile || {},
          commercial_intelligence: analysisResult.commercial_intelligence || {},
          persuasion_strategy: analysisResult.persuasion_strategy || {}
        })
      },
      credits: {
        used: creditCost,
        remaining: userResult.credits - creditCost,
        actual_cost: costDetails.actual_cost,
        margin: creditCost - costDetails.actual_cost
      },
      metadata: {
        request_id: requestId,
        analysis_completed_at: new Date().toISOString(),
        schema_version: '3.1',
        system_used: 'direct_analysis',
        performance: {
          processing_duration_ms: processingTime,
          model_used: costDetails.model_used,
          block_type: costDetails.block_type,
          tokens_processed: costDetails.tokens_in + costDetails.tokens_out
        }
      }
    };

    logger('info', 'Analysis completed successfully', { 
      run_id, 
      lead_id,
      username: profileData.username, 
      overall_score: analysisResult.score,
      confidence: analysisResult.confidence_level,
      dataQuality: profileData.dataQuality,
      system: 'direct_analysis',
      processing_time: processingTime,
      actual_cost: costDetails.actual_cost
    });

    return c.json(createStandardResponse(true, responseData, undefined, requestId));

  } catch (error: any) {
    logger('error', 'Analysis request failed', { error: error.message, requestId });
    return c.json(createStandardResponse(false, undefined, error.message, requestId), 500);
  }
}
