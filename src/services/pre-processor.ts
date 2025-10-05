import type { ProfileData } from '../types/interfaces.js';
import { analyzeContentIntelligence, type ContentIntelligence } from './content-analyzer.js';
import { analyzePostingPatterns, type PostingPatterns } from './posting-analyzer.js';
import { logger } from '../utils/logger.js';

export interface PreProcessedMetrics {
  engagement: any; // Already exists from calculateRealEngagement
  content: ContentIntelligence | null;
  posting: PostingPatterns | null;
  summary: string;
}

export function runPreProcessing(profile: ProfileData): PreProcessedMetrics {
  logger('info', 'Running pre-processing pipeline', { 
    username: profile.username,
    postsCount: profile.latestPosts?.length || 0
  });

  const posts = profile.latestPosts || [];
  
  if (posts.length === 0) {
    return {
      engagement: profile.engagement || null,
      content: null,
      posting: null,
      summary: 'No posts available for pre-processing'
    };
  }

  // Run all analyzers
  const contentIntel = analyzeContentIntelligence(posts);
  const postingPatterns = analyzePostingPatterns(posts);

  // Build intelligent summary
  const summary = buildIntelligentSummary(profile, contentIntel, postingPatterns);

  logger('info', 'Pre-processing complete', {
    username: profile.username,
    hasContent: !!contentIntel,
    hasPosting: !!postingPatterns,
    summaryLength: summary.length
  });

  return {
    engagement: profile.engagement,
    content: contentIntel,
    posting: postingPatterns,
    summary
  };
}

function buildIntelligentSummary(
  profile: ProfileData,
  content: ContentIntelligence | null,
  posting: PostingPatterns | null
): string {
  const parts: string[] = [];

  // Engagement summary
  if (profile.engagement) {
    const eng = profile.engagement;
    parts.push(
      `Engagement: ${eng.engagementRate}% ER (${eng.avgLikes} likes, ${eng.avgComments} comments avg from ${eng.postsAnalyzed} posts)`
    );
    
    if (eng.videoPerformance) {
      parts.push(
        `Video Performance: ${eng.videoPerformance.avgViews} avg views, ${eng.videoPerformance.viewToEngagementRatio}% view-to-engagement`
      );
    }
    
    if (eng.formatDistribution) {
      parts.push(
        `Content Mix: ${eng.formatDistribution.primaryFormat} primary (${eng.formatDistribution.formatDiversity}/3 format diversity)`
      );
    }
  }

  // Content summary
  if (content) {
    parts.push(
      `Topics: ${content.contentThemes}`
    );
    
    if (content.collaborationSignals.taggedAccountsCount > 0) {
      parts.push(
        `Collaborates with ${content.collaborationSignals.taggedAccountsCount} accounts (${(content.collaborationSignals.collaborationFrequency * 100).toFixed(0)}% of posts)`
      );
    }
    
    if (content.locationData.usesLocations) {
      parts.push(
        `Uses geo-tags (${content.locationData.locationCount} locations)`
      );
    }
  }

  // Posting summary
  if (posting) {
    parts.push(
      `Posting: ${posting.postsPerWeek}x/week, ${posting.consistencyLevel} consistency, ${posting.postingVelocity} velocity`
    );
    parts.push(
      `Last posted ${posting.daysSinceLastPost} days ago, ${posting.recentPostsLast30Days} posts in last 30 days`
    );
  }

  return parts.join(' | ');
}
