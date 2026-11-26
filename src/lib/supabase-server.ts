import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

const makeFailClosedFetch = (label: string): typeof fetch => async () => {
  throw new Error(`[supabase-server] Missing required Supabase configuration for ${label}.`);
};

/**
 * Client for standard authenticated/anonymous requests (Enforces Row Level Security)
 */
export const supabaseClient = createClient(
  supabaseUrl || 'https://unconfigured.invalid',
  supabaseAnonKey || 'missing-anon-key',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    ...(supabaseUrl && supabaseAnonKey ? {} : { global: { fetch: makeFailClosedFetch('supabaseClient') } }),
  }
);

/**
 * Admin client utilizing Service Role Key (Bypasses RLS - Server-Side Execution Only)
 * Used strictly for administrative verifications, user upserts, and privileged RPC calls.
 */
export const supabaseAdmin = createClient(
  supabaseUrl || 'https://unconfigured.invalid',
  supabaseServiceRoleKey || 'missing-service-role-key',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
    ...(supabaseUrl && supabaseServiceRoleKey ? {} : { global: { fetch: makeFailClosedFetch('supabaseAdmin') } }),
  }
);
