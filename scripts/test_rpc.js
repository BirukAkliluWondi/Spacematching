const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://plusmfmlzzumzsqtlixb.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBsdXNtZm1senp1bXpzcXRsaXhiIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTk1OTM1NiwiZXhwIjoyMTA3NTM1MzU2fQ.1nXAUO7usoDst_maNIE252DHyK-NtHPazQY0ats7qVE';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const { data, error } = await supabaseAdmin.rpc('get_unlocked_space_details', {
    p_space_id: '00000000-0000-0000-0000-000000000000',
    p_telegram_id: 123456
  });
  console.log('RPC test:', { data, error });
}

main();
