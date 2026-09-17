const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://lzatfklszrovfqoyufnt.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6YXRma2xzenJvdmZxb3l1Zm50Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTU3OTkyNiwiZXhwIjoyMTA1MTU1OTI2fQ.zFc4zfTJ9uUG88VmC8SichqDNsaAcSwAI4AEYcPNxzg';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const publicUrl = `${supabaseUrl}/storage/v1/object/public/spaces-public/space_test_1789656866406.jpg`;
  console.log('Updating space_images for space 73d7815e-c01b-4b0d-9bf4-9668cffcdd73 to:', publicUrl);

  const res = await supabaseAdmin
    .from('space_images')
    .update({ image_path: publicUrl })
    .eq('space_id', '73d7815e-c01b-4b0d-9bf4-9668cffcdd73');

  console.log('Update result:', res);
}

main().catch(err => console.error(err));
