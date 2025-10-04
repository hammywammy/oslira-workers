import type { PostData } from '../types/interfaces.js';
import { logger } from '../utils/logger.js';

export interface PostingPatterns {
  postsPerWeek: number;
  recentPostsLast30Days: number;
  daysSinceLastPost: number;
  consistencyScore: number;
  consistencyLevel: 'high' | 'moderate' | 'low';
  avgDaysBetweenPosts: number;
  postingVelocity: 'increasing' | 'stable' | 'decreasing';
}

export function analyzePostingPatterns(posts: PostData[]): PostingPatterns | null {
  if (!posts || posts.length < 2) return null;

  // Sort posts by timestamp (newest first)
  const sortedPosts = [...posts].sort((a, b) => 
    new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  const now = new Date();
  const oldestPost = new Date(sortedPosts[sortedPosts.length - 1].timestamp);
  const newestPost = new Date(sortedPosts[0].timestamp);
  
  // Calculate time ranges
  const totalDays = (newestPost.getTime() - oldestPost.getTime()) / (1000 * 60 * 60 * 24);
  const daysSinceLastPost = Math.round((now.getTime() - newestPost.getTime()) / (1000 * 60 * 60 * 24));
  
  // Posts per week calculation
  const postsPerWeek = totalDays > 0 ? parseFloat(((posts.length / totalDays) * 7).toFixed(1)) : 0;

  // Recent activity (last 30 days)
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const recentPostsLast30Days = posts.filter(p => 
    new Date(p.timestamp) > thirtyDaysAgo
  ).length;

  // Calculate gaps between posts for consistency scoring
  const gaps: number[] = [];
  for (let i = 0; i < sortedPosts.length - 1; i++) {
    const gap = (new Date(sortedPosts[i].timestamp).getTime() - 
                 new Date(sortedPosts[i + 1].timestamp).getTime()) / (1000 * 60 * 60 * 24);
    gaps.push(gap);
  }
  
  const avgDaysBetweenPosts = gaps.length > 0 ? 
    parseFloat((gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toFixed(1)) : 0;
  
  // Standard deviation for consistency
  const avgGap = avgDaysBetweenPosts;
  const variance = gaps.reduce((sum, gap) => sum + Math.pow(gap - avgGap, 2), 0) / gaps.length;
  const stdDev = Math.sqrt(variance);
  
  // Consistency score (lower stdDev = more consistent)
  const consistencyScore = Math.max(0, Math.min(100, Math.round(100 - (stdDev * 2))));
  const consistencyLevel: 'high' | 'moderate' | 'low' = 
    consistencyScore > 70 ? 'high' :
    consistencyScore > 40 ? 'moderate' : 'low';

  // Posting velocity trend (compare recent vs older activity)
  const midpoint = Math.floor(sortedPosts.length / 2);
  const recentHalf = sortedPosts.slice(0, midpoint);
  const olderHalf = sortedPosts.slice(midpoint);
  
  const recentDays = (new Date(recentHalf[0].timestamp).getTime() - 
                      new Date(recentHalf[recentHalf.length - 1].timestamp).getTime()) / (1000 * 60 * 60 * 24);
  const olderDays = (new Date(olderHalf[0].timestamp).getTime() - 
                     new Date(olderHalf[olderHalf.length - 1].timestamp).getTime()) / (1000 * 60 * 60 * 24);
  
  const recentFreq = recentDays > 0 ? recentHalf.length / recentDays : 0;
  const olderFreq = olderDays > 0 ? olderHalf.length / olderDays : 0;
  
  const postingVelocity: 'increasing' | 'stable' | 'decreasing' = 
    recentFreq > olderFreq * 1.2 ? 'increasing' :
    recentFreq < olderFreq * 0.8 ? 'decreasing' : 'stable';

  return {
    postsPerWeek,
    recentPostsLast30Days,
    daysSinceLastPost,
    consistencyScore,
    consistencyLevel,
    avgDaysBetweenPosts,
    postingVelocity
  };
}
