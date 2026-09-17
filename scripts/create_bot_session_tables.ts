import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lzatfklszrovfqoyufnt.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6YXRma2xzenJvdmZxb3l1Zm50Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTU3OTkyNiwiZXhwIjoyMTA1MTU1OTI2fQ.zFc4zfTJ9uUG88VmC8SichqDNsaAcSwAI4AEYcPNxzg';

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
