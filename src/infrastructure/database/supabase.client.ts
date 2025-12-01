import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { getSecret } from '@/infrastructure/config/secrets';
import { SECRET_KEYS } from '@/config/secrets.constants';
import type { Env } from '@/shared/types/env.types';

// Client cache (per Worker instance)
let userClientCache: SupabaseClient | null = null;
let adminClientCache: SupabaseClient | null = null;

/**
 * Create Supabase client with anon key (RLS enforced)
 * Use for: User-facing queries, frontend-like operations
 * 
 * @example
 * const supabase = await createUserClient(env);
 * const { data } = await supabase.from('leads').select('*').eq('account_id', accountId);
 */
export async function createUserClient(env: Env): Promise<SupabaseClient> {
  // Return cached client if exists
  if (userClientCache) {
    return userClientCache;
  }

  const supabaseUrl = await getSecret(SECRET_KEYS.SUPABASE_URL, env, env.APP_ENV);
  const anonKey = await getSecret(SECRET_KEYS.SUPABASE_ANON_KEY, env, env.APP_ENV);
  
  userClientCache = createClient(supabaseUrl, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
  
  return userClientCache;
}

/**
 * Create Supabase client with service role key (bypasses RLS)
 * Use for: System operations, credit deductions, cron jobs
 * 
 * ⚠️ CRITICAL: Only use in backend Worker, NEVER expose to frontend
 * 
 * @example
 * const supabase = await createAdminClient(env);
 * await supabase.rpc('deduct_credits', { p_account_id, p_amount: -2, ... });
 */
export async function createAdminClient(env: Env): Promise<SupabaseClient> {
  // Return cached client if exists
  if (adminClientCache) {
    return adminClientCache;
  }

  const supabaseUrl = await getSecret(SECRET_KEYS.SUPABASE_URL, env, env.APP_ENV);
  const serviceRoleKey = await getSecret(SECRET_KEYS.SUPABASE_SERVICE_ROLE_KEY, env, env.APP_ENV);
  
  adminClientCache = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
  
  return adminClientCache;
}

/**
 * Clear client cache (useful for testing or secret rotation)
 */
export function clearClientCache(): void {
  userClientCache = null;
  adminClientCache = null;
}

// ADD THIS EXPORT:
export const SupabaseClientFactory = {
  createUserClient,
  createAdminClient,
  clearClientCache
};
