import type { D1Database } from '@cloudflare/workers-types';

export interface Env {
  // Database
  DB: D1Database;

  // API Keys & Tokens
  GITHUB_TOKEN: string;
  UNSPLASH_ACCESS_KEY: string;
  FIRECRAWL_API_KEY: string;
  DEV_TO_API_KEY?: string;

  // Optional: R2 for image storage
  BLOG_IMAGES?: R2Bucket;

  // Environment
  ENVIRONMENT: 'production' | 'staging' | 'development';
}
