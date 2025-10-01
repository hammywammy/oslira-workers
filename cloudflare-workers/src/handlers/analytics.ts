import type { Env } from '../types/interfaces.js';
import { fetchJson } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

// ===============================================================================
// SHARED UTILITIES - REMOVE REDUNDANCY
// ===============================================================================

const createHeaders = (env: Env) => ({
  apikey: env.SUPABASE_SERVICE_ROLE,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
  'Content-Type': 'application/json'
});

const getTimeRanges = () => {
  const now = new Date();
  return {
    now,
    sevenDaysAgo: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    thirtyDaysAgo: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(),
    fourteenDaysAgo: new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString()
  };
};

const calculateAverage = (values: number[]): number => 
  values.length > 0 ? Math.round(values.reduce((sum, val) => sum + val, 0) / values.length) : 0;

const filterByTimeRange = (items: any[], timeField: string, cutoffDate: string) =>
  items.filter(item => item[timeField] > cutoffDate);

const calculateGrowthRate = (current: number, previous: number): number =>
  previous > 0 ? Math.round(((current - previous) / previous) * 100) : (current > 0 ? 100 : 0);

// ===============================================================================
// ANALYTICS DASHBOARD SUMMARY
// ===============================================================================

export async function getAnalyticsSummary(env: Env): Promise<any> {
  const headers = createHeaders(env);
  const { sevenDaysAgo, thirtyDaysAgo } = getTimeRanges();

  try {
    // Updated queries for new 3-table structure
    const [leadsWithRuns, payloadsData, usersResponse] = await Promise.all([
      // Get leads with their latest runs
      fetchJson<any[]>(
        `${env.SUPABASE_URL}/rest/v1/leads?select=lead_id,username,follower_count,first_discovered_at,runs(run_id,analysis_type,overall_score,niche_fit_score,engagement_score,created_at)&order=runs.created_at.desc`,
        { headers }
      ),
      // Get payload data for engagement analysis
      fetchJson<any[]>(
        `${env.SUPABASE_URL}/rest/v1/payloads?select=analysis_data,created_at,analysis_type`,
        { headers }
      ),
      // Get user data
      fetchJson<any[]>(
        `${env.SUPABASE_URL}/rest/v1/users?select=id,created_at,subscription_status,credits`,
        { headers }
      )
    ]);

    // Flatten runs data for analysis
    const allRuns = leadsWithRuns.flatMap(lead => 
      lead.runs?.map(run => ({
        ...run,
        lead_id: lead.lead_id,
        username: lead.username,
        follower_count: lead.follower_count
      })) || []
    );

    // Core metrics based on runs (not leads)
    const totalAnalyses = allRuns.length;
    const recentAnalyses = filterByTimeRange(allRuns, 'created_at', sevenDaysAgo).length;
    const monthlyAnalyses = filterByTimeRange(allRuns, 'created_at', thirtyDaysAgo).length;
    const uniqueLeads = new Set(allRuns.map(run => run.lead_id)).size;
    
    // Score analysis from runs table
    const scores = allRuns.map(run => run.overall_score || 0);
    const nicheFitScores = allRuns.map(run => run.niche_fit_score || 0);
    const engagementScores = allRuns.map(run => run.engagement_score || 0);
    
    const avgOverallScore = calculateAverage(scores);
    const avgNicheFitScore = calculateAverage(nicheFitScores);
    const avgEngagementScore = calculateAverage(engagementScores);
    
    const highScoreAnalyses = scores.filter(score => score > 75).length;
    const conversionRate = totalAnalyses > 0 ? Math.round((highScoreAnalyses / totalAnalyses) * 100) : 0;
    
    // Engagement analysis from payloads
    const deepPayloads = payloadsData.filter(p => p.analysis_type === 'deep');
    const engagementRates = deepPayloads
      .map(p => p.analysis_data?.engagement_breakdown?.engagement_rate || 0)
      .filter(rate => rate > 0);
    const avgEngagementRate = calculateAverage(engagementRates) / 100;
    
    // User metrics
    const activeUsers = usersResponse.filter(user => user.subscription_status === 'active').length;
    const totalCreditsAvailable = usersResponse.reduce((sum, user) => sum + (user.credits || 0), 0);
    
    // Analysis type breakdown
    const analysisBreakdown = {
      light: allRuns.filter(run => run.analysis_type === 'light').length,
      deep: allRuns.filter(run => run.analysis_type === 'deep').length,
      xray: allRuns.filter(run => run.analysis_type === 'xray').length
    };
    
    // Growth calculation
    const previousWeekRuns = filterByTimeRange(allRuns, 'created_at', getTimeRanges().fourteenDaysAgo)
      .filter(run => new Date(run.created_at) <= new Date(sevenDaysAgo)).length;
    const growthRate = calculateGrowthRate(recentAnalyses, previousWeekRuns);

    return {
      success: true,
      summary: {
        totalAnalyses,
        uniqueLeads,
        averageOverallScore: avgOverallScore,
        averageNicheFitScore: avgNicheFitScore,
        averageEngagementScore: avgEngagementScore,
        conversionRate: `${conversionRate}%`,
        avgEngagementRate: `${avgEngagementRate}%`,
        recentActivity: recentAnalyses,
        monthlyActivity: monthlyAnalyses,
        activeUsers,
        totalCreditsAvailable,
        analysisBreakdown
      },
      trends: {
        analysesGrowth: `${growthRate >= 0 ? '+' : ''}${growthRate}%`,
        scoreImprovement: avgOverallScore > 60 ? "above_average" : "needs_improvement",
        engagementTrend: avgEngagementRate > 3 ? "healthy" : "low_engagement",
        userGrowth: activeUsers > 0 ? "active" : "no_subscribers"
      },
      insights: {
        topPerformingScore: Math.max(...scores, 0),
        mostActiveWeek: recentAnalyses > previousWeekRuns ? "current" : "previous",
        recommendedFocus: conversionRate < 20 ? "improve_lead_quality" : "scale_operations",
        engagementBenchmark: avgEngagementRate > 3 ? "exceeds_benchmark" : "below_benchmark"
      }
    };

  } catch (error: any) {
    logger('error', 'getAnalyticsSummary failed', { error: error.message });
    return {
      success: false,
      error: error.message,
      summary: {
        totalAnalyses: 0,
        uniqueLeads: 0,
        averageOverallScore: 0,
        conversionRate: "0%",
        avgEngagementRate: "0%",
        recentActivity: 0,
        monthlyActivity: 0,
        activeUsers: 0,
        totalCreditsAvailable: 0,
        analysisBreakdown: { light: 0, deep: 0, xray: 0 }
      }
    };
  }
}

// ===============================================================================
// ENHANCED ANALYTICS WITH AI INSIGHTS
// ===============================================================================

export async function getEnhancedAnalytics(
  user_id: string,
  business_id: string,
  env: Env
): Promise<any> {
  const headers = createHeaders(env);
  const { sevenDaysAgo } = getTimeRanges();

  try {
    // Get user-specific data with new structure
    const [userLeadsRuns, userPayloads] = await Promise.all([
      // User's leads with runs
      fetchJson<any[]>(
        `${env.SUPABASE_URL}/rest/v1/leads?select=lead_id,username,display_name,follower_count,first_discovered_at,runs(run_id,analysis_type,overall_score,niche_fit_score,engagement_score,created_at)&user_id=eq.${user_id}&business_id=eq.${business_id}&order=runs.created_at.desc`,
        { headers }
      ),
      // User's analysis payloads
      fetchJson<any[]>(
        `${env.SUPABASE_URL}/rest/v1/payloads?select=analysis_data,analysis_type,created_at&user_id=eq.${user_id}&business_id=eq.${business_id}`,
        { headers }
      )
    ]);

    // Flatten runs data
    const allRuns = userLeadsRuns.flatMap(lead => 
      lead.runs?.map(run => ({
        ...run,
        lead_id: lead.lead_id,
        username: lead.username,
        follower_count: lead.follower_count
      })) || []
    );

    const totalAnalyses = allRuns.length;
    const totalLeads = userLeadsRuns.length;

    if (totalAnalyses === 0) {
      return {
        success: true,
        insights: ["No analyses completed yet"],
        recommendations: ["Complete your first analysis to see insights"],
        performance: { overall_score: 0, niche_fit: 0, engagement: 0 }
      };
    }

    // Calculate performance metrics using shared utilities
    const scores = allRuns.map(run => run.overall_score || 0);
    const nicheFitScores = allRuns.map(run => run.niche_fit_score || 0);
    const engagementScores = allRuns.map(run => run.engagement_score || 0);

    const avgOverallScore = calculateAverage(scores);
    const avgNicheFitScore = calculateAverage(nicheFitScores);
    const avgEngagementScore = calculateAverage(engagementScores);

    // Recent performance (last 7 days)
    const recentRuns = filterByTimeRange(allRuns, 'created_at', sevenDaysAgo);
    const recentAvgScore = calculateAverage(recentRuns.map(run => run.overall_score || 0));

    // Engagement analysis from payloads
    const deepPayloads = userPayloads.filter(p => p.analysis_type === 'deep');
    const engagementRates = deepPayloads
      .map(p => p.analysis_data?.engagement_breakdown?.engagement_rate || 0)
      .filter(rate => rate > 0);
    const avgEngagementRate = calculateAverage(engagementRates) / 100;

    // Performance segmentation
    const highScoreProfiles = scores.filter(score => score > 75).length;
    const mediumScoreProfiles = scores.filter(score => score >= 50 && score <= 75).length;
    const lowScoreProfiles = scores.filter(score => score < 50).length;

    // Follower analysis
    const followerCounts = userLeadsRuns.map(lead => lead.follower_count || 0);
    const avgFollowers = calculateAverage(followerCounts);
    const microInfluencers = followerCounts.filter(count => count >= 1000 && count <= 100000).length;
    const macroInfluencers = followerCounts.filter(count => count > 100000).length;

    // Analysis type breakdown
    const analysisBreakdown = {
      light: allRuns.filter(run => run.analysis_type === 'light').length,
      deep: allRuns.filter(run => run.analysis_type === 'deep').length,
      xray: allRuns.filter(run => run.analysis_type === 'xray').length
    };

    // Success rate calculation
    const successRate = totalAnalyses > 0 ? Math.round((highScoreProfiles / totalAnalyses) * 100) : 0;

    // Trend analysis
    const isImproving = recentAvgScore > avgOverallScore;
    const trendDirection = isImproving ? "positive" : (recentAvgScore === avgOverallScore ? "stable" : "negative");

    // Generate insights and recommendations using shared logic
    const { insights, recommendations } = generateInsightsAndRecommendations({
      avgOverallScore,
      avgEngagementRate,
      microInfluencers,
      avgFollowers,
      analysisBreakdown,
      totalAnalyses,
      trendDirection,
      recentAvgScore,
      successRate
    });

    return {
      success: true,
      performance: {
        overall_score: avgOverallScore,
        niche_fit: avgNicheFitScore,
        engagement: avgEngagementScore,
        engagement_rate: avgEngagementRate,
        success_rate: successRate,
        trend_direction: trendDirection
      },
      segmentation: {
        high_performers: highScoreProfiles,
        medium_performers: mediumScoreProfiles,
        low_performers: lowScoreProfiles,
        micro_influencers: microInfluencers,
        macro_influencers: macroInfluencers
      },
      analysis_breakdown: {
        total_analyses: totalAnalyses,
        ...analysisBreakdown,
        deep_analysis_ratio: Math.round((analysisBreakdown.deep / totalAnalyses) * 100)
      },
      insights,
      recommendations,
      metrics: {
        avg_followers: avgFollowers,
        recent_performance: recentAvgScore,
        total_leads: totalLeads,
        analyses_this_week: recentRuns.length
      }
    };

  } catch (error: any) {
    logger('error', 'getEnhancedAnalytics failed', { error: error.message });
    return {
      success: false,
      error: error.message,
      performance: { overall_score: 0, niche_fit: 0, engagement: 0 },
      insights: ["Unable to generate insights due to data error"],
      recommendations: ["Please try again or contact support"]
    };
  }
}

// ===============================================================================
// SHARED INSIGHTS GENERATION
// ===============================================================================

function generateInsightsAndRecommendations(metrics: {
  avgOverallScore: number;
  avgEngagementRate: number;
  microInfluencers: number;
  avgFollowers: number;
  analysisBreakdown: any;
  totalAnalyses: number;
  trendDirection: string;
  recentAvgScore: number;
  successRate: number;
}): { insights: string[]; recommendations: string[] } {
  const insights: string[] = [];
  const recommendations: string[] = [];

  // Score-based insights
  if (metrics.avgOverallScore > 75) {
    insights.push(`Excellent lead quality with ${metrics.avgOverallScore}/100 average score`);
  } else if (metrics.avgOverallScore > 50) {
    insights.push(`Moderate lead quality with ${metrics.avgOverallScore}/100 average score - room for improvement`);
    recommendations.push("Focus on higher-quality prospects to improve overall scores");
  } else {
    insights.push(`Low lead quality detected with ${metrics.avgOverallScore}/100 average score`);
    recommendations.push("Review your targeting criteria and source higher-quality leads");
  }

  // Engagement insights
  if (metrics.avgEngagementRate > 3) {
    insights.push(`Strong engagement rates averaging ${metrics.avgEngagementRate}%`);
  } else if (metrics.avgEngagementRate > 0) {
    insights.push(`Below-average engagement at ${metrics.avgEngagementRate}% - Instagram benchmark is 3-6%`);
    recommendations.push("Target accounts with higher engagement rates for better results");
  }

  // Follower insights
  if (metrics.microInfluencers > 0) {
    insights.push(`${metrics.microInfluencers} micro-influencers identified (1K-100K followers) - highest conversion potential`);
  }
  if (metrics.avgFollowers > 50000) {
    insights.push(`High-follower targets averaging ${metrics.avgFollowers.toLocaleString()} followers`);
  }

  // Analysis depth insights
  const deepAnalysisRatio = Math.round((metrics.analysisBreakdown.deep / metrics.totalAnalyses) * 100);
  if (deepAnalysisRatio < 30) {
    recommendations.push("Consider more deep analyses for better outreach personalization");
  }

  // Trend insights
  if (metrics.trendDirection === "positive") {
    insights.push(`Performance improving - recent scores up ${metrics.recentAvgScore - metrics.avgOverallScore} points`);
  } else if (metrics.trendDirection === "negative") {
    insights.push(`Performance declining - recent scores down ${metrics.avgOverallScore - metrics.recentAvgScore} points`);
    recommendations.push("Review recent lead sources and adjust targeting strategy");
  }

  // Success rate insights
  if (metrics.successRate > 50) {
    insights.push(`High success rate: ${metrics.successRate}% of leads score above 75`);
  } else if (metrics.successRate > 25) {
    insights.push(`Moderate success rate: ${metrics.successRate}% of leads score above 75`);
    recommendations.push("Refine targeting to increase high-scoring leads");
  } else {
    insights.push(`Low success rate: only ${metrics.successRate}% of leads score above 75`);
    recommendations.push("Significantly improve lead sourcing and qualification criteria");
  }

  return { insights, recommendations };
}

// ===============================================================================
// LEADERBOARD FUNCTIONS - OPTIMIZED
// ===============================================================================

export async function getTopPerformers(
  user_id?: string,
  business_id?: string,
  env?: Env,
  limit: number = 10
): Promise<any> {
  const headers = createHeaders(env!);

  try {
    let query = `${env!.SUPABASE_URL}/rest/v1/runs?select=run_id,overall_score,niche_fit_score,engagement_score,analysis_type,created_at,leads(username,display_name,follower_count,profile_picture_url)&order=overall_score.desc&limit=${limit}`;
    
    if (user_id && business_id) {
      query += `&user_id=eq.${user_id}&business_id=eq.${business_id}`;
    }

    const response = await fetchJson<any[]>(query, { headers });

    const topPerformers = response.map((run, index) => ({
      rank: index + 1,
      run_id: run.run_id,
      username: run.leads?.username || 'Unknown',
      display_name: run.leads?.display_name || null,
      profile_picture_url: run.leads?.profile_picture_url || null,
      follower_count: run.leads?.follower_count || 0,
      overall_score: run.overall_score,
      niche_fit_score: run.niche_fit_score,
      engagement_score: run.engagement_score,
      analysis_type: run.analysis_type,
      analyzed_at: run.created_at
    }));

    const scores = topPerformers.map(p => p.overall_score);
    const avgTopScore = calculateAverage(scores);

    return {
      success: true,
      top_performers: topPerformers,
      metrics: {
        highest_score: Math.max(...scores, 0),
        average_top_score: avgTopScore,
        total_analyzed: response.length
      }
    };

  } catch (error: any) {
    logger('error', 'getTopPerformers failed', { error: error.message });
    return {
      success: false,
      error: error.message,
      top_performers: [],
      metrics: { highest_score: 0, average_top_score: 0, total_analyzed: 0 }
    };
  }
}

// ===============================================================================
// RECENT ACTIVITY FEED - OPTIMIZED
// ===============================================================================

export async function getRecentActivity(
  user_id: string,
  business_id: string,
  env: Env,
  limit: number = 20
): Promise<any> {
  const headers = createHeaders(env);

  try {
    const query = `${env.SUPABASE_URL}/rest/v1/runs?select=run_id,analysis_type,overall_score,summary_text,created_at,leads(username,display_name,profile_picture_url,follower_count)&user_id=eq.${user_id}&business_id=eq.${business_id}&order=created_at.desc&limit=${limit}`;

    const response = await fetchJson<any[]>(query, { headers });

    const activities = response.map(run => ({
      run_id: run.run_id,
      type: 'analysis_completed',
      analysis_type: run.analysis_type,
      username: run.leads?.username || 'Unknown',
      display_name: run.leads?.display_name || null,
      profile_picture_url: run.leads?.profile_picture_url || null,
      follower_count: run.leads?.follower_count || 0,
      score: run.overall_score,
      summary: run.summary_text || `${run.analysis_type} analysis completed`,
      timestamp: run.created_at,
      time_ago: getTimeAgo(run.created_at)
    }));

    return {
      success: true,
      activities,
      total_count: activities.length
    };

  } catch (error: any) {
    logger('error', 'getRecentActivity failed', { error: error.message });
    return {
      success: false,
      error: error.message,
      activities: [],
      total_count: 0
    };
  }
}

// ===============================================================================
// HELPER FUNCTIONS - OPTIMIZED
// ===============================================================================

function getTimeAgo(timestamp: string): string {
  const now = new Date();
  const past = new Date(timestamp);
  const diffInMinutes = Math.floor((now.getTime() - past.getTime()) / (1000 * 60));
  
  if (diffInMinutes < 1) return 'Just now';
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 7) return `${diffInDays}d ago`;
  
  const diffInWeeks = Math.floor(diffInDays / 7);
  return `${diffInWeeks}w ago`;
}

// ===============================================================================
// BUSINESS INTELLIGENCE QUERIES - OPTIMIZED
// ===============================================================================

export async function getBusinessIntelligence(
  user_id: string,
  business_id: string,
  env: Env
): Promise<any> {
  const headers = createHeaders(env);
  const { thirtyDaysAgo, sevenDaysAgo } = getTimeRanges();

  try {
    const allData = await fetchJson<any[]>(
      `${env.SUPABASE_URL}/rest/v1/runs?select=*,leads(*),payloads(analysis_data)&user_id=eq.${user_id}&business_id=eq.${business_id}&order=created_at.desc`,
      { headers }
    );

    if (allData.length === 0) {
      return {
        success: true,
        intelligence: {
          summary: "No analysis data available for business intelligence",
          recommendations: ["Complete more analyses to generate insights"]
        }
      };
    }

    // Time-based performance analysis using shared utilities
    const last30Days = filterByTimeRange(allData, 'created_at', thirtyDaysAgo);
    const last7Days = filterByTimeRange(allData, 'created_at', sevenDaysAgo);

    const monthlyAvgScore = calculateAverage(last30Days.map(run => run.overall_score || 0));
    const weeklyAvgScore = calculateAverage(last7Days.map(run => run.overall_score || 0));

    // Industry benchmarking
    const microInfluencerRuns = allData.filter(run => 
      run.leads?.follower_count >= 1000 && run.leads?.follower_count <= 100000
    );
    const macroInfluencerRuns = allData.filter(run => 
      run.leads?.follower_count > 100000
    );

    const microAvgScore = calculateAverage(microInfluencerRuns.map(run => run.overall_score));
    const macroAvgScore = calculateAverage(macroInfluencerRuns.map(run => run.overall_score));

    // Quality scoring
    const highQualityRuns = allData.filter(run => run.overall_score > 80);
    const qualityRate = Math.round((highQualityRuns.length / allData.length) * 100);

    return {
      success: true,
      intelligence: {
        performance_summary: {
          total_analyses: allData.length,
          monthly_average_score: monthlyAvgScore,
          weekly_average_score: weeklyAvgScore,
          quality_rate: `${qualityRate}%`,
          trend: weeklyAvgScore > monthlyAvgScore ? "improving" : "declining"
        },
        audience_insights: {
          micro_influencer_performance: microAvgScore,
          macro_influencer_performance: macroAvgScore,
          recommended_segment: microInfluencerRuns.length > macroInfluencerRuns.length ? "micro_influencers" : "macro_influencers"
        },
        strategic_recommendations: generateStrategicRecommendations(allData, qualityRate, weeklyAvgScore, monthlyAvgScore)
      }
    };

  } catch (error: any) {
    logger('error', 'getBusinessIntelligence failed', { error: error.message });
    return {
      success: false,
      error: error.message,
      intelligence: {
        summary: "Unable to generate business intelligence",
        recommendations: ["Please try again or contact support"]
      }
    };
  }
}

function generateStrategicRecommendations(data: any[], qualityRate: number, weeklyAvg: number, monthlyAvg: number): string[] {
  const recommendations = [];

  if (qualityRate < 20) {
    recommendations.push("Improve lead sourcing criteria - less than 20% of leads are high-quality");
    recommendations.push("Consider partnering with influencer marketing platforms for better lead discovery");
  } else if (qualityRate > 60) {
    recommendations.push("Excellent lead quality - scale your analysis volume to maximize opportunities");
  }

  if (weeklyAvg < monthlyAvg) {
    recommendations.push("Recent performance decline detected - review and adjust targeting strategy");
  } else if (weeklyAvg > monthlyAvg + 5) {
    recommendations.push("Performance improving - continue current targeting approach");
  }

  const deepAnalyses = data.filter(run => run.analysis_type === 'deep').length;
  const lightAnalyses = data.filter(run => run.analysis_type === 'light').length;
  
  if (deepAnalyses < lightAnalyses * 0.3) {
    recommendations.push("Increase deep analysis ratio for better outreach personalization");
  }

  if (data.length > 50) {
    recommendations.push("Consider implementing automated workflows for high-volume lead processing");
  }

  return recommendations.length > 0 ? recommendations : ["Continue current strategy - performance is on track"];
}
