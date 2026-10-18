const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://plusmfmlzzumzsqtlixb.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsdXNtZm1senp1bXpzcXRsaXhiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTk1OTM1NiwiZXhwIjoyMTA3NTM1MzU2fQ.1nXAUO7usoDst_maNIE252DHyK-NtHPazQY0ats7qVE';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const tables = ['users', 'spaces', 'space_images', 'orders'];
  for (const t of tables) {
    const res = await supabaseAdmin.from(t).select('*').limit(1);
    console.log(`Table ${t}:`, res.error ? res.error.message : `OK (${res.data.length} rows)`);
  }
}

main().catch(err => console.error(err));
