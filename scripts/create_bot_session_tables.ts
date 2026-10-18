import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://plusmfmlzzumzsqtlixb.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsdXNtZm1senp1bXpzcXRsaXhiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTk1OTM1NiwiZXhwIjoyMTA3NTM1MzU2fQ.1nXAUO7usoDst_maNIE252DHyK-NtHPazQY0ats7qVE';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function setupTables() {
  console.log('Checking bot_sessions and pending_space_drafts tables...');
  const { error: sessionCheck } = await supabaseAdmin.from('users').select('telegram_id').limit(1);
  if (sessionCheck) {
    console.log('Check error:', sessionCheck.message);
  } else {
    console.log('Users table verified!');
  }
}

setupTables();
