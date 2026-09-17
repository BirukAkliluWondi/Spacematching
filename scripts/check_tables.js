const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://lzatfklszrovfqoyufnt.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6YXRma2xzenJvdmZxb3l1Zm50Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTU3OTkyNiwiZXhwIjoyMTA1MTU1OTI2fQ.zFc4zfTJ9uUG88VmC8SichqDNsaAcSwAI4AEYcPNxzg';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const tables = ['users', 'spaces', 'space_images', 'orders'];
  for (const t of tables) {
    const res = await supabaseAdmin.from(t).select('*').limit(1);
    console.log(`Table ${t}:`, res.error ? res.error.message : `OK (${res.data.length} rows)`);
  }
}

main().catch(err => console.error(err));
