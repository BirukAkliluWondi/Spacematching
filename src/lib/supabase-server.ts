import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://plusmfmlzzumzsqtlixb.supabase.co'
).trim();

const supabaseAnonKey = (
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsdXNtZm1senp1bXpzcXRsaXhiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE5NTkzNTYsImV4cCI6MjEwNzUzNTM1Nn0.GLJ7zchrWjFHtYRkwtSIvzpp-asHwW3LJHEPtPXmf68'
).trim();

const supabaseServiceRoleKey = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsdXNtZm1senp1bXpzcXRsaXhiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTk1OTM1NiwiZXhwIjoyMTA3NTM1MzU2fQ.1nXAUO7usoDst_maNIE252DHyK-NtHPazQY0ats7qVE'
).trim();

/**
 * Client for standard authenticated/anonymous requests (Enforces Row Level Security)
 */
export const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

/**
 * Admin client utilizing Service Role Key (Bypasses RLS - Server-Side Execution Only)
 * Used strictly for administrative verifications, user upserts, and privileged RPC calls.
 */
export const supabaseAdmin = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  }
);
