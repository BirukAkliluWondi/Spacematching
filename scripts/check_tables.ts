import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://plusmfmlzzumzsqtlixb.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsdXNtZm1senp1bXpzcXRsaXhiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTk1OTM1NiwiZXhwIjoyMTA3NTM1MzU2fQ.1nXAUO7usoDst_maNIE252DHyK-NtHPazQY0ats7qVE';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  console.log('Testing bot_sessions...');
  const res1 = await supabaseAdmin.from('bot_sessions').select('*').limit(1);
  console.log('bot_sessions response:', res1);

  console.log('Testing pending_space_drafts...');
  const res2 = await supabaseAdmin.from('pending_space_drafts').select('*').limit(1);
  console.log('pending_space_drafts response:', res2);
}

main();
