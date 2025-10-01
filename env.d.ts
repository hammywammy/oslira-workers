// env.d.ts
export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      SUPABASE_URL: string;
      SUPABASE_SERVICE_ROLE: string;
      SUPABASE_ANON_KEY: string;
      OPENAI_KEY: string;
      CLAUDE_KEY?: string;
      APIFY_API_TOKEN: string;
      STRIPE_SECRET_KEY: string;
      STRIPE_WEBHOOK_SECRET?: string;
      FRONTEND_URL?: string;
    }
  }
}
