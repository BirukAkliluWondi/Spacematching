import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
const supabaseAnonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '').trim();
const supabaseServiceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

/**
 * Client for standard authenticated/anonymous requests (Enforces Row Level Security)
 */
export const supabaseClient = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseAnonKey || 'missing-anon-key',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);

/**
 * Admin client utilizing Service Role Key (Bypasses RLS - Server-Side Execution Only)
 * Used strictly for administrative verifications, user upserts, and privileged RPC calls.
 */
export const supabaseAdmin = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseServiceRoleKey || 'missing-service-role-key',
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);
