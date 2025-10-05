import type { PostData } from '../types/interfaces.js';
import { logger } from '../utils/logger.js';

export interface ContentIntelligence {
  topHashtags: Array<{ tag: string; count: number }>;
  contentThemes: string;
  avgCaptionLength: number;
  captionStyle: 'brief' | 'moderate' | 'detailed';
  collaborationSignals: {
    taggedAccountsCount: number;
    topCollaborators: string[];
    collaborationFrequency: number;
  };
  locationData: {
    usesLocations: boolean;
    locationCount: number;
    topLocations: string[];
  };
}

export function analyzeContentIntelligence(posts: PostData[]): ContentIntelligence | null {
  if (!posts || posts.length === 0) return null;

  // Extract all hashtags
  const allHashtags = posts
    .flatMap(p => p.hashtags || [])
    .map(h => h.toLowerCase().replace(/^#/, ''));
  
  // Count hashtag frequency
  const hashtagCounts: Record<string, number> = {};
  allHashtags.forEach(tag => {
    hashtagCounts[tag] = (hashtagCounts[tag] || 0) + 1;
  });
  
  // Get top 5 hashtags
  const topHashtags = Object.entries(hashtagCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([tag, count]) => ({ tag, count }));
  
  // Content themes from top 3 hashtags
  const contentThemes = topHashtags
    .slice(0, 3)
    .map(h => h.tag)
    .join(', ') || 'general content';

  // Caption analysis
  const captions = posts.map(p => p.caption || '');
  const totalCaptionLength = captions.reduce((sum, cap) => sum + cap.length, 0);
  const avgCaptionLength = Math.round(totalCaptionLength / posts.length);
  
  const captionStyle: 'brief' | 'moderate' | 'detailed' = 
    avgCaptionLength < 50 ? 'brief' :
    avgCaptionLength < 150 ? 'moderate' : 'detailed';

  // Collaboration signals - extract from raw post data
  const taggedAccounts = new Set<string>();
  posts.forEach(post => {
    // Check for taggedUsers in raw post data
    const rawPost = post as any;
    if (rawPost.taggedUsers && Array.isArray(rawPost.taggedUsers)) {
      rawPost.taggedUsers.forEach((user: any) => {
        const username = user.username || user;
        if (username) taggedAccounts.add(username);
      });
    }
  });

  const taggedAccountsArray = Array.from(taggedAccounts);
  const topCollaborators = taggedAccountsArray.slice(0, 3);
  const collaborationFrequency = parseFloat((taggedAccountsArray.length / posts.length).toFixed(2));

  // Location data
  const locationsUsed = new Set<string>();
  posts.forEach(post => {
    const rawPost = post as any;
    if (rawPost.location && rawPost.location.name) {
      locationsUsed.add(rawPost.location.name);
    }
  });

  const locationsArray = Array.from(locationsUsed);

  return {
    topHashtags,
    contentThemes,
    avgCaptionLength,
    captionStyle,
    collaborationSignals: {
      taggedAccountsCount: taggedAccountsArray.length,
      topCollaborators,
      collaborationFrequency
    },
    locationData: {
      usesLocations: locationsArray.length > 0,
      locationCount: locationsArray.length,
      topLocations: locationsArray.slice(0, 3)
    }
  };
}
