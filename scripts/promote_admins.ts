import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://lzatfklszrovfqoyufnt.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6YXRma2xzenJvdmZxb3l1Zm50Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTU3OTkyNiwiZXhwIjoyMTA1MTU1OTI2fQ.zFc4zfTJ9uUG88VmC8SichqDNsaAcSwAI4AEYcPNxzg';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function promoteToAdmin() {
  const targetUsernames = ['WWEHID', 'birukadiyee'];

  console.log('Promoting usernames to admin role...', targetUsernames);

  for (const uname of targetUsernames) {
    // 1. Check if user already exists by username
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('id, telegram_id, username, role')
      .ilike('username', uname)
      .maybeSingle();

    if (existingUser) {
      const { data, error } = await supabaseAdmin
        .from('users')
        .update({ role: 'admin', fayda_status: 'verified' })
        .eq('id', existingUser.id)
        .select();

      if (error) {
        console.error(`Error updating @${uname}:`, error);
      } else {
        console.log(`✅ Successfully updated existing user @${uname} to admin role!`);
      }
    } else {
      console.log(`User @${uname} not found yet in database. Pre-inserting admin placeholder...`);
      // Insert placeholder so when they log in by telegram_id their username or role is active
      const tempId = Math.floor(100000000 + Math.random() * 900000000);
      const { error } = await supabaseAdmin
        .from('users')
        .insert({
          telegram_id: tempId,
          first_name: uname,
          username: uname,
          role: 'admin',
          fayda_status: 'verified',
        });

      if (error) {
        console.error(`Error pre-inserting placeholder for @${uname}:`, error);
      } else {
        console.log(`✅ Pre-created admin record for @${uname}!`);
      }
    }
  }
}

promoteToAdmin();
