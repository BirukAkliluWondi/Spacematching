const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://lzatfklszrovfqoyufnt.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6YXRma2xzenJvdmZxb3l1Zm50Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTU3OTkyNiwiZXhwIjoyMTA1MTU1OTI2fQ.zFc4zfTJ9uUG88VmC8SichqDNsaAcSwAI4AEYcPNxzg';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  console.log('--- 1. LOCAL DRAFTS ---');
  const draftsFile = path.join(__dirname, '../data/pending_space_drafts.json');
  if (fs.existsSync(draftsFile)) {
    console.log(fs.readFileSync(draftsFile, 'utf-8'));
  } else {
    console.log('No local drafts file found.');
  }

  console.log('\n--- 2. SUPABASE PUBLIC.SPACES ---');
  const res1 = await supabaseAdmin.from('spaces').select('*');
  console.log('spaces:', res1.data, res1.error);

  console.log('\n--- 3. SUPABASE PUBLIC_SPACES_VIEW ---');
  const res2 = await supabaseAdmin.from('public_spaces_view').select('*');
  console.log('public_spaces_view:', res2.data, res2.error);
}

main().catch(err => console.error(err));
