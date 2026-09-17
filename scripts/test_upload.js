const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = 'https://lzatfklszrovfqoyufnt.supabase.co';
const supabaseServiceKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6YXRma2xzenJvdmZxb3l1Zm50Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTU3OTkyNiwiZXhwIjoyMTA1MTU1OTI2fQ.zFc4zfTJ9uUG88VmC8SichqDNsaAcSwAI4AEYcPNxzg';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

async function main() {
  const telegramPhotoUrl = 'https://api.telegram.org/file/bot8415131791:AAFQ1ozuyXyxPm3Zdr50T9gqeR8sVeoQNS4/photos/file_6.jpg';
  console.log('Downloading photo from Telegram...');
  const res = await fetch(telegramPhotoUrl);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const fileName = `space_test_${Date.now()}.jpg`;
  console.log('Uploading to Supabase Storage spaces-public as:', fileName);

  const { data, error } = await supabaseAdmin.storage
    .from('spaces-public')
    .upload(fileName, buffer, {
      contentType: 'image/jpeg',
      upsert: true,
    });

  console.log('Upload result:', { data, error });

  if (data) {
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/spaces-public/${fileName}`;
    console.log('Public Storage URL:', publicUrl);

    // Update existing approved space image_path to this publicUrl
    const { data: updateData, error: updateErr } = await supabaseAdmin
      .from('space_images')
      .update({ image_path: publicUrl })
      .eq('space_id', '73d7815e-c01b-4b0d-9bf4-9668cffcdd73');

    console.log('Updated space_images:', { updateData, updateErr });
  }
}

main().catch(err => console.error(err));
