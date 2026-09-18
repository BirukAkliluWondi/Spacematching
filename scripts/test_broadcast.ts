if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is required.');
  process.exit(1);
}
process.env.NEXT_PUBLIC_BOT_USERNAME = 'Spacematchaddis_bot';
process.env.NEXT_PUBLIC_TELEGRAM_APP_NAME = 'roommatch';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://lzatfklszrovfqoyufnt.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx6YXRma2xzenJvdmZxb3l1Zm50Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4OTU3OTkyNiwiZXhwIjoyMTA1MTU1OTI2fQ.zFc4zfTJ9uUG88VmC8SichqDNsaAcSwAI4AEYcPNxzg';

async function main() {
  const { broadcastListingToChannel } = await import('../src/lib/telegram-broadcast');
  const listingId = '73d7815e-c01b-4b0d-9bf4-9668cffcdd73';
  console.log('Testing broadcast to target chat 800701176 for listing:', listingId);
  const result = await broadcastListingToChannel(listingId, '800701176');
  console.log('Broadcast Result:', result);
}

main().catch((err) => console.error(err));
