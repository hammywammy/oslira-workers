// ===============================================================================
// ANONYMOUS ANALYSIS HANDLER - Rate Limited, Cost-Effective
// File: cloudflare-workers/src/handlers/anonymous-analyze.ts
// ===============================================================================

import type { Context } from 'hono';
import type { Env } from '../types/interfaces.js';
import { generateRequestId, logger } from '../utils/logger.js';
import { createStandardResponse } from '../utils/response.js';
import { withScraperRetry } from '../utils/scraper-error-handler.js';
import { getScraperConfigsAdvanced, validateAndTransformScraperData } from '../services/scraper-configs.js';
import { getApiKey } from '../services/enhanced-config-manager.js';
import { extractUsername } from '../utils/validation.js';

// ===============================================================================
// RATE LIMITING WITH CLOUDFLARE KV
// ===============================================================================

interface RateLimitData {
  attempts: string[];
  resetTime: string;
}

async function checkRateLimit(c: Context<{ Bindings: Env }>): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const clientIP = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For') || 'unknown';
  const key = `rate_limit:${clientIP}`;
  
  try {
    // Get existing rate limit data
    const existing = await c.env.OSLIRA_KV.get(key);
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const nextReset = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    
    let rateLimitData: RateLimitData;
    
    if (existing) {
      rateLimitData = JSON.parse(existing);
      // Filter out old attempts (older than 24 hours)
      rateLimitData.attempts = rateLimitData.attempts.filter(
        attempt => new Date(attempt) > dayStart
      );
    } else {
      rateLimitData = { attempts: [], resetTime: nextReset.toISOString() };
    }
    
const remaining = Math.max(0, 1 - rateLimitData.attempts.length);
const resetIn = Math.ceil((nextReset.getTime() - now.getTime()) / (1000 * 60 * 60)); // Hours

if (rateLimitData.attempts.length >= 1) {
      return { allowed: false, remaining: 0, resetIn };
    }
    
    // Add current attempt
    rateLimitData.attempts.push(now.toISOString());
    rateLimitData.resetTime = nextReset.toISOString();
    
    // Store updated data (expire in 25 hours to be safe)
    await c.env.OSLIRA_KV.put(key, JSON.stringify(rateLimitData), { expirationTtl: 25 * 60 * 60 });
    
    return { allowed: true, remaining: remaining - 1, resetIn };
    
} catch (error: any) {
    logger('error', 'Rate limit check failed', { error: error.message, clientIP });
    // On error, allow the request (fail open)
    return { allowed: true, remaining: 0, resetIn: 24 };
  }
}

// ===============================================================================
// ANONYMOUS ANALYSIS PROCESSING
// ===============================================================================

async function performAnonymousAnalysis(username: string, env: Env): Promise<any> {
  try {
    // STEP 1: Use the same scraper system as main analyze
    const { scrapeInstagramProfile } = await import('../services/instagram-scraper.js');
    const profileData = await scrapeInstagramProfile(username, 'light', env);
    
    logger('info', 'Profile scraped successfully for anonymous analysis', { 
      username, 
      followersCount: profileData.followersCount,
      scraperUsed: profileData.scraperUsed
    });

    // STEP 2: Generate lightweight GPT insights
    const insights = await generateAnonymousInsights(profileData, env);
    
    return {
      profile: {
        username: profileData.username,
        displayName: profileData.displayName,
        bio: profileData.bio,
        followersCount: profileData.followersCount,
        followingCount: profileData.followingCount,
        postsCount: profileData.postsCount,
        isVerified: profileData.isVerified,
        isPrivate: profileData.isPrivate,
        isBusinessAccount: profileData.isBusinessAccount,
        profilePicUrl: profileData.profilePicUrl,
        externalUrl: profileData.externalUrl
      },
      insights,
      analysis_type: 'anonymous',
      scraper_used: profileData.scraperUsed
    };
    
  } catch (error: any) {
    logger('error', 'Anonymous analysis failed', { username, error: error.message });
    throw error;
  }
}

async function generateAnonymousInsights(profileData: any, env: Env): Promise<any> {
  try {
const openaiApiKey = await getApiKey('OPENAI_API_KEY', env, env.APP_ENV);
if (!openaiApiKey) {
  throw new Error('OpenAI API key not configured');
}

    logger('info', 'Starting GPT insights generation', {
      username: profileData.username,
      followersCount: profileData.followersCount,
      postsCount: profileData.postsCount,
      hasApiKey: !!openaiApiKey
    });

    const prompt = `Analyze this Instagram profile for general marketing potential and provide insights:

Profile Data:
- Username: @${profileData.username}
- Display Name: ${profileData.displayName || 'Not set'}
- Followers: ${profileData.followersCount || 0}
- Following: ${profileData.followingCount || 0}
- Posts: ${profileData.postsCount || 0}
- Bio: "${profileData.bio || 'No bio available'}"
- Verified: ${profileData.isVerified || false}
- Business Account: ${profileData.isBusinessAccount || false}
- Private Account: ${profileData.isPrivate || false}

IMPORTANT: Return ONLY valid JSON without markdown code blocks or extra formatting.

Provide a JSON response with:
1. overall_score (0-100): Account quality and partnership potential
2. account_summary: 2-3 sentence overview of the account's marketing appeal
3. engagement_insights: Array of exactly 5 strategic insights for potential brand partnerships
4. audience_quality: One of "high", "medium", "low" based on follower count and engagement indicators
5. partnership_potential: Brief assessment of collaboration opportunities

Focus on general appeal, authenticity, and business partnership potential.`;

    const requestBody = {
      model: 'gpt-4o-mini',
      messages: [{ 
        role: 'user', 
        content: prompt 
      }],
      max_tokens: 1000,
      temperature: 0.7
    };

    logger('info', 'Sending OpenAI request', {
      username: profileData.username,
      model: requestBody.model,
      maxTokens: requestBody.max_tokens,
      promptLength: prompt.length
    });

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openaiApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    logger('info', 'OpenAI response received', {
      username: profileData.username,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger('error', 'OpenAI API error', {
        username: profileData.username,
        status: response.status,
        error: errorText
      });
      throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    logger('info', 'OpenAI data parsed', {
      username: profileData.username,
      hasChoices: !!data.choices,
      choicesLength: data.choices?.length || 0,
      hasContent: !!data.choices?.[0]?.message?.content,
      usage: data.usage,
      contentPreview: data.choices?.[0]?.message?.content?.substring(0, 100) || 'No content'
    });
    
    if (!data.choices?.[0]?.message?.content) {
      throw new Error('Invalid response from OpenAI API - no content');
    }

    const rawContent = data.choices[0].message.content;
    
    logger('info', 'Raw GPT response', {
      username: profileData.username,
      contentLength: rawContent.length,
      startsWithCodeBlock: rawContent.startsWith('```'),
      fullContent: rawContent
    });

    try {
      // Clean the response - remove code blocks if present
      let cleanContent = rawContent.trim();
      if (cleanContent.startsWith('```json')) {
        cleanContent = cleanContent.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanContent.startsWith('```')) {
        cleanContent = cleanContent.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      logger('info', 'Cleaned GPT response', {
        username: profileData.username,
        originalLength: rawContent.length,
        cleanedLength: cleanContent.length,
        cleanedContent: cleanContent
      });

      const insights = JSON.parse(cleanContent);
      
      logger('info', 'GPT response parsed successfully', {
        username: profileData.username,
        overallScore: insights.overall_score,
        hasAccountSummary: !!insights.account_summary,
        insightsCount: insights.engagement_insights?.length || 0,
        audienceQuality: insights.audience_quality,
        allFields: Object.keys(insights)
      });
      
      // Validate required fields
      if (!insights.overall_score || !insights.account_summary || !insights.engagement_insights) {
        logger('error', 'Missing required fields in GPT response', {
          username: profileData.username,
          hasScore: !!insights.overall_score,
          hasSummary: !!insights.account_summary,
          hasInsights: !!insights.engagement_insights,
          fields: Object.keys(insights)
        });
        throw new Error('Missing required fields in GPT response');
      }

      return insights;
      
    } catch (parseError: any) {
      logger('error', 'Failed to parse GPT response, using fallback', { 
        username: profileData.username,
        error: parseError.message,
        rawContent: rawContent,
        contentType: typeof rawContent
      });
      
      // Fallback response with calculated insights
      return generateFallbackInsights(profileData);
    }
    
  } catch (error: any) {
    logger('error', 'GPT insights generation failed', { 
      username: profileData.username,
      error: error.message,
      stack: error.stack
    });
    
    // Return fallback insights
    return generateFallbackInsights(profileData);
  }
}

function generateFallbackInsights(profileData: any): any {
  const followerCount = profileData.followersCount || 0;
  const followingCount = profileData.followingCount || 0;
  const postsCount = profileData.postsCount || 0;
  
  logger('info', 'Generating fallback insights', {
    username: profileData.username,
    followerCount,
    followingCount,
    postsCount,
    isVerified: profileData.isVerified,
    isBusinessAccount: profileData.isBusinessAccount,
    isPrivate: profileData.isPrivate
  });
  
  // Calculate basic scores
  const followerScore = Math.min(100, Math.log10(followerCount + 1) * 20);
  const engagementScore = followerCount > 0 ? Math.min(100, (postsCount / (followerCount / 1000)) * 10) : 50;
  const accountScore = (profileData.isVerified ? 20 : 0) + (profileData.isBusinessAccount ? 15 : 0) + (!profileData.isPrivate ? 10 : 0);
  
  const overall_score = Math.round((followerScore + engagementScore + accountScore) / 3);
  
  logger('info', 'Fallback score calculation', {
    username: profileData.username,
    followerScore: Math.round(followerScore),
    engagementScore: Math.round(engagementScore),
    accountScore,
    overall_score
  });
  
  // Determine audience quality
  let audience_quality = 'low';
  if (followerCount > 100000) audience_quality = 'high';
  else if (followerCount > 10000) audience_quality = 'medium';
  
  // Generate insights based on profile characteristics
  const insights = [];
  
  if (followerCount > 50000) {
    insights.push('Strong follower base indicates established audience trust and reach potential');
  } else if (followerCount > 5000) {
    insights.push('Growing audience suggests authentic engagement and organic reach');
  } else {
    insights.push('Micro-influencer profile ideal for niche targeting and authentic partnerships');
  }
  
  if (profileData.isVerified) {
    insights.push('Verified status adds credibility and professional appeal for brand collaborations');
  }
  
  if (profileData.isBusinessAccount) {
    insights.push('Business account setup demonstrates professional approach to content creation');
  }
  
  if (postsCount > 100) {
    insights.push('Consistent content creation history shows commitment and audience engagement');
  }
  
  if (profileData.bio && profileData.bio.length > 20) {
    insights.push('Well-crafted bio indicates professional presentation and clear value proposition');
  }
  
  // Fill remaining slots if needed
  while (insights.length < 5) {
    const fallbackInsights = [
      'Profile optimization indicates understanding of platform best practices',
      'Account metrics suggest potential for meaningful brand partnerships',
      'Content approach shows awareness of audience engagement strategies',
      'Social proof elements demonstrate established platform presence'
    ];
    
    for (const fallback of fallbackInsights) {
      if (!insights.includes(fallback) && insights.length < 5) {
        insights.push(fallback);
      }
    }
  }

  const fallbackResult = {
    overall_score,
    account_summary: `${followerCount > 10000 ? 'Established' : 'Emerging'} content creator with ${audience_quality} audience quality and ${profileData.isBusinessAccount ? 'professional' : 'personal'} brand approach. ${profileData.isVerified ? 'Verified status adds credibility.' : 'Shows potential for growth and partnerships.'}`,
    engagement_insights: insights.slice(0, 5),
    audience_quality,
    partnership_potential: followerCount > 50000 ? 'High potential for major brand collaborations' : 
                          followerCount > 10000 ? 'Good fit for mid-tier brand partnerships' : 
                          'Ideal for niche and micro-influencer campaigns'
  };

  logger('info', 'Fallback insights generated', {
    username: profileData.username,
    result: fallbackResult
  });

  return fallbackResult;
}

// ===============================================================================
// MAIN HANDLER
// ===============================================================================

export async function handleAnonymousAnalyze(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = generateRequestId();
  
  try {
    // Check rate limiting first
    const rateLimit = await checkRateLimit(c);
    
    if (!rateLimit.allowed) {
      logger('warn', 'Rate limit exceeded for anonymous analysis', { 
        clientIP: c.req.header('CF-Connecting-IP') || 'unknown',
        requestId 
      });
      
      return c.json(createStandardResponse(
        false,
        undefined,
        `Daily limit reached. Reset in ${rateLimit.resetIn} hours.`,
        requestId,
        { remaining: 0, resetIn: rateLimit.resetIn }
      ), 429);
    }
    
    // Parse and validate request
    const body = await c.req.json();
    const { username } = body;
    
    if (!username) {
      return c.json(createStandardResponse(false, undefined, 'Username required', requestId), 400);
    }
    
    // Clean and validate username
    const cleanUsername = extractUsername(username);
    
    if (!cleanUsername) {
      return c.json(createStandardResponse(false, undefined, 'Invalid username format', requestId), 400);
    }
    
    logger('info', 'Anonymous analysis started', { 
      username: cleanUsername, 
      clientIP: c.req.header('CF-Connecting-IP') || 'unknown',
      requestId 
    });
    
    // Check cache first (6 hour cache for anonymous analyses)
    const cacheKey = `anon_analysis:${cleanUsername}`;
    
    try {
      const cached = await c.env.OSLIRA_KV.get(cacheKey);
      if (cached) {
        const cachedData = JSON.parse(cached);
        logger('info', 'Anonymous analysis cache hit', { username: cleanUsername, requestId });
        
        return c.json(createStandardResponse(
          true,
          cachedData,
          'Analysis complete (cached)',
          requestId,
          { remaining: rateLimit.remaining, cached: true }
        ));
      }
    } catch (cacheError: any) {
      logger('warn', 'Cache read failed, proceeding with fresh analysis', { 
        error: cacheError.message,
        requestId 
      });
    }
    
    // Perform fresh analysis
    const analysisResult = await performAnonymousAnalysis(cleanUsername, c.env);
    
    // Cache the result for 6 hours
    try {
      await c.env.OSLIRA_KV.put(
        cacheKey, 
        JSON.stringify(analysisResult), 
        { expirationTtl: 6 * 60 * 60 }
      );
    } catch (cacheError: any) {
      logger('warn', 'Failed to cache analysis result', { 
        error: cacheError.message,
        requestId 
      });
    }
    
    logger('info', 'Anonymous analysis completed successfully', { 
      username: cleanUsername, 
      score: analysisResult.insights.overall_score,
      scraperUsed: analysisResult.scraper_used,
      requestId 
    });
    
    return c.json(createStandardResponse(
      true,
      analysisResult,
      'Analysis complete',
      requestId,
      { remaining: rateLimit.remaining, cached: false }
    ));
    
  } catch (error: any) {
    logger('error', 'Anonymous analysis failed', { 
      error: error.message,
      stack: error.stack,
      requestId 
    });
    
    // Return user-friendly error message
    let errorMessage = 'Analysis failed. Please try again.';
    
    if (error.message.includes('not found')) {
      errorMessage = 'Instagram profile not found. Please check the username.';
    } else if (error.message.includes('private')) {
      errorMessage = 'This Instagram profile is private and cannot be analyzed.';
    } else if (error.message.includes('rate limit')) {
      errorMessage = 'Instagram is temporarily limiting requests. Please try again in a few minutes.';
    } else if (error.message.includes('not configured')) {
      errorMessage = 'Service temporarily unavailable. Please try again later.';
    }
    
    return c.json(createStandardResponse(
      false,
      undefined,
      errorMessage,
      requestId
    ), 500);
  }
}
