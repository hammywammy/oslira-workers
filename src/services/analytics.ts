import type { Env } from '../types/interfaces.js';
import { fetchJson } from '../utils/helpers.js';
import { logger } from '../utils/logger.js';

// ===============================================================================
// ANALYTICS DASHBOARD SUMMARY
// ===============================================================================

export async function getAnalyticsSummary(env: Env): Promise<any> {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json'
  };

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

    // Calculate time-based metrics
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    // Core metrics based on runs (not leads)
    const totalAnalyses = allRuns.length;
    const recentAnalyses = allRuns.filter(run => run.created_at > sevenDaysAgo).length;
    const monthlyAnalyses = allRuns.filter(run => run.created_at > thirtyDaysAgo).length;
    const uniqueLeads = new Set(allRuns.map(run => run.lead_id)).size;
    
    // Score analysis from runs table
    const avgOverallScore = totalAnalyses > 0 ? 
      Math.round(allRuns.reduce((sum, run) => sum + (run.overall_score || 0), 0) / totalAnalyses) : 0;
    
    const avgNicheFitScore = totalAnalyses > 0 ? 
      Math.round(allRuns.reduce((sum, run) => sum + (run.niche_fit_score || 0), 0) / totalAnalyses) : 0;
    
    const avgEngagementScore = totalAnalyses > 0 ? 
      Math.round(allRuns.reduce((sum, run) => sum + (run.engagement_score || 0), 0) / totalAnalyses) : 0;
    
    const highScoreAnalyses = allRuns.filter(run => (run.overall_score || 0) > 75).length;
    const conversionRate = totalAnalyses > 0 ? Math.round((highScoreAnalyses / totalAnalyses) * 100) : 0;
    
    // Engagement analysis from payloads
    const deepPayloads = payloadsData.filter(p => p.analysis_type === 'deep');
    let avgEngagementRate = 0;
    if (deepPayloads.length > 0) {
      const engagementRates = deepPayloads
        .map(p => p.analysis_data?.engagement_breakdown?.engagement_rate || 0)
        .filter(rate => rate > 0);
      avgEngagementRate = engagementRates.length > 0 ? 
        Math.round(engagementRates.reduce((sum, rate) => sum + rate, 0) / engagementRates.length * 100) / 100 : 0;
    }
    
    // User metrics
    const activeUsers = usersResponse.filter(user => user.subscription_status === 'active').length;
    const totalCreditsAvailable = usersResponse.reduce((sum, user) => sum + (user.credits || 0), 0);
    
    // Analysis type breakdown
    const lightAnalyses = allRuns.filter(run => run.analysis_type === 'light').length;
    const deepAnalyses = allRuns.filter(run => run.analysis_type === 'deep').length;
    const xrayAnalyses = allRuns.filter(run => run.analysis_type === 'xray').length;
    
    // Growth calculation
    const previousWeekRuns = allRuns.filter(run => {
      const runDate = new Date(run.created_at);
      const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
      return runDate > twoWeeksAgo && runDate <= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }).length;
    
    const growthRate = previousWeekRuns > 0 ? 
      Math.round(((recentAnalyses - previousWeekRuns) / previousWeekRuns) * 100) : 
      (recentAnalyses > 0 ? 100 : 0);

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
        analysisBreakdown: {
          light: lightAnalyses,
          deep: deepAnalyses,
          xray: xrayAnalyses
        }
      },
      trends: {
        analysesGrowth: `${growthRate >= 0 ? '+' : ''}${growthRate}%`,
        scoreImprovement: avgOverallScore > 60 ? "above_average" : "needs_improvement",
        engagementTrend: avgEngagementRate > 3 ? "healthy" : "low_engagement",
        userGrowth: activeUsers > 0 ? "active" : "no_subscribers"
      },
      insights: {
        topPerformingScore: Math.max(...allRuns.map(run => run.overall_score || 0)),
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
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json'
  };

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

    // Calculate performance metrics
    const avgOverallScore = Math.round(allRuns.reduce((sum, run) => sum + (run.overall_score || 0), 0) / totalAnalyses);
    const avgNicheFitScore = Math.round(allRuns.reduce((sum, run) => sum + (run.niche_fit_score || 0), 0) / totalAnalyses);
    const avgEngagementScore = Math.round(allRuns.reduce((sum, run) => sum + (run.engagement_score || 0), 0) / totalAnalyses);

    // Recent performance (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentRuns = allRuns.filter(run => run.created_at > sevenDaysAgo);
    const recentAvgScore = recentRuns.length > 0 ?
      Math.round(recentRuns.reduce((sum, run) => sum + (run.overall_score || 0), 0) / recentRuns.length) : avgOverallScore;

    // Engagement analysis from payloads
    const deepPayloads = userPayloads.filter(p => p.analysis_type === 'deep');
    let avgEngagementRate = 0;
    if (deepPayloads.length > 0) {
      const engagementRates = deepPayloads
        .map(p => p.analysis_data?.engagement_breakdown?.engagement_rate || 0)
        .filter(rate => rate > 0);
      avgEngagementRate = engagementRates.length > 0 ? 
        Math.round(engagementRates.reduce((sum, rate) => sum + rate, 0) / engagementRates.length * 100) / 100 : 0;
    }

    // Performance segmentation
    const highScoreProfiles = allRuns.filter(run => (run.overall_score || 0) > 75).length;
    const mediumScoreProfiles = allRuns.filter(run => (run.overall_score || 0) >= 50 && (run.overall_score || 0) <= 75).length;
    const lowScoreProfiles = allRuns.filter(run => (run.overall_score || 0) < 50).length;

    // Follower analysis
    const avgFollowers = totalLeads > 0 ?
      Math.round(userLeadsRuns.reduce((sum, lead) => sum + (lead.follower_count || 0), 0) / totalLeads) : 0;
    const microInfluencers = userLeadsRuns.filter(lead => (lead.follower_count || 0) >= 1000 && (lead.follower_count || 0) <= 100000).length;
    const macroInfluencers = userLeadsRuns.filter(lead => (lead.follower_count || 0) > 100000).length;

    // Analysis type breakdown
    const lightAnalyses = allRuns.filter(run => run.analysis_type === 'light').length;
    const deepAnalyses = allRuns.filter(run => run.analysis_type === 'deep').length;
    const xrayAnalyses = allRuns.filter(run => run.analysis_type === 'xray').length;

    // Success rate calculation
    const successRate = totalAnalyses > 0 ? Math.round((highScoreProfiles / totalAnalyses) * 100) : 0;

// Trend analysis
    const isImproving = recentAvgScore > avgOverallScore;
    const trendDirection = isImproving ? "positive" : (recentAvgScore === avgOverallScore ? "stable" : "negative");

    // Generate insights based on real data
    const insights = [];
    const recommendations = [];

    // Score-based insights
    if (avgOverallScore > 75) {
      insights.push(`Excellent lead quality with ${avgOverallScore}/100 average score`);
    } else if (avgOverallScore > 50) {
      insights.push(`Moderate lead quality with ${avgOverallScore}/100 average score - room for improvement`);
      recommendations.push("Focus on higher-quality prospects to improve overall scores");
    } else {
      insights.push(`Low lead quality detected with ${avgOverallScore}/100 average score`);
      recommendations.push("Review your targeting criteria and source higher-quality leads");
    }

    // Engagement insights
    if (avgEngagementRate > 3) {
      insights.push(`Strong engagement rates averaging ${avgEngagementRate}%`);
    } else if (avgEngagementRate > 0) {
      insights.push(`Below-average engagement at ${avgEngagementRate}% - Instagram benchmark is 3-6%`);
      recommendations.push("Target accounts with higher engagement rates for better results");
    }

    // Follower insights
    if (microInfluencers > 0) {
      insights.push(`${microInfluencers} micro-influencers identified (1K-100K followers) - highest conversion potential`);
    }
    if (avgFollowers > 50000) {
      insights.push(`High-follower targets averaging ${avgFollowers.toLocaleString()} followers`);
    }

    // Analysis depth insights
    const deepAnalysisRatio = Math.round((deepAnalyses / totalAnalyses) * 100);
    if (deepAnalysisRatio < 30) {
      recommendations.push("Consider more deep analyses for better outreach personalization");
    }

    // Trend insights
    if (trendDirection === "positive") {
      insights.push(`Performance improving - recent scores up ${recentAvgScore - avgOverallScore} points`);
    } else if (trendDirection === "negative") {
      insights.push(`Performance declining - recent scores down ${avgOverallScore - recentAvgScore} points`);
      recommendations.push("Review recent lead sources and adjust targeting strategy");
    }

    // Success rate insights
    if (successRate > 50) {
      insights.push(`High success rate: ${successRate}% of leads score above 75`);
    } else if (successRate > 25) {
      insights.push(`Moderate success rate: ${successRate}% of leads score above 75`);
      recommendations.push("Refine targeting to increase high-scoring leads");
    } else {
      insights.push(`Low success rate: only ${successRate}% of leads score above 75`);
      recommendations.push("Significantly improve lead sourcing and qualification criteria");
    }

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
        light: lightAnalyses,
        deep: deepAnalyses,
        xray: xrayAnalyses,
        deep_analysis_ratio: deepAnalysisRatio
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
// LEADERBOARD FUNCTIONS
// ===============================================================================

export async function getTopPerformers(
  user_id?: string,
  business_id?: string,
  env?: Env,
  limit: number = 10
): Promise<any> {
  const headers = {
    apikey: env!.SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${env!.SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json'
  };

  try {
    // Build query for top performers using new structure
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

    return {
      success: true,
      top_performers: topPerformers,
      metrics: {
        highest_score: topPerformers[0]?.overall_score || 0,
        average_top_score: topPerformers.length > 0 ? 
          Math.round(topPerformers.reduce((sum, p) => sum + p.overall_score, 0) / topPerformers.length) : 0,
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
// RECENT ACTIVITY FEED
// ===============================================================================

export async function getRecentActivity(
  user_id: string,
  business_id: string,
  env: Env,
  limit: number = 20
): Promise<any> {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json'
  };

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
// HELPER FUNCTIONS
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
// BUSINESS INTELLIGENCE QUERIES
// ===============================================================================

export async function getBusinessIntelligence(
  user_id: string,
  business_id: string,
  env: Env
): Promise<any> {
  const headers = {
    apikey: env.SUPABASE_SERVICE_ROLE,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json'
  };

  try {
    // Get all user's runs with lead data for comprehensive analysis
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

    // Time-based performance analysis
    const last30Days = allData.filter(run => {
      const runDate = new Date(run.created_at);
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      return runDate > thirtyDaysAgo;
    });

    const last7Days = allData.filter(run => {
      const runDate = new Date(run.created_at);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      return runDate > sevenDaysAgo;
    });

    // Performance trends
    const monthlyAvgScore = last30Days.length > 0 ? 
      Math.round(last30Days.reduce((sum, run) => sum + (run.overall_score || 0), 0) / last30Days.length) : 0;
    
    const weeklyAvgScore = last7Days.length > 0 ? 
      Math.round(last7Days.reduce((sum, run) => sum + (run.overall_score || 0), 0) / last7Days.length) : 0;

    // Industry benchmarking (based on follower counts and engagement)
    const microInfluencerRuns = allData.filter(run => 
      run.leads?.follower_count >= 1000 && run.leads?.follower_count <= 100000
    );
    const macroInfluencerRuns = allData.filter(run => 
      run.leads?.follower_count > 100000
    );

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
          micro_influencer_performance: microInfluencerRuns.length > 0 ? 
            Math.round(microInfluencerRuns.reduce((sum, run) => sum + run.overall_score, 0) / microInfluencerRuns.length) : 0,
          macro_influencer_performance: macroInfluencerRuns.length > 0 ? 
            Math.round(macroInfluencerRuns.reduce((sum, run) => sum + run.overall_score, 0) / macroInfluencerRuns.length) : 0,
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
