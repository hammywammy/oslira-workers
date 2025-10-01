import { logger } from './logger.js';

export class ScraperErrorHandler {
  static transformError(error: any, username: string): Error {
    if (error.message.includes('not found') || error.message.includes('404')) {
      return new Error('Instagram profile not found');
    }
    if (error.message.includes('private') || error.message.includes('403')) {
      return new Error('This Instagram profile is private');
    }
    if (error.message.includes('rate limit') || error.message.includes('429')) {
      return new Error('Instagram is temporarily limiting requests. Please try again in a few minutes.');
    }
    if (error.message.includes('timeout')) {
      return new Error('Profile scraping timed out. Please try again.');
    }
    return new Error('Failed to retrieve profile data');
  }

  static shouldRetryError(error: any): boolean {
    return !error.message.includes('not found') && !error.message.includes('private');
  }
}

export async function withScraperRetry<T>(
  attempts: Array<() => Promise<T>>,
  username: string
): Promise<T> {
  let lastError: Error | null = null;

  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (error: any) {
      logger('warn', `Scraper attempt failed`, { username, error: error.message });
      lastError = error;
      
      if (!ScraperErrorHandler.shouldRetryError(error)) {
        throw ScraperErrorHandler.transformError(error, username);
      }
    }
  }

  throw ScraperErrorHandler.transformError(lastError!, username);
}
