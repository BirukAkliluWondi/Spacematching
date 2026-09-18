const botToken = process.env.TELEGRAM_BOT_TOKEN;
const domain = process.env.NEXT_PUBLIC_APP_URL || process.argv[2];
const webhookUrl = domain ? `${domain.replace(/\/$/, '')}/api/telegram/webhook` : null;

if (!botToken) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

if (!webhookUrl) {
  console.error('ERROR: Please provide domain via NEXT_PUBLIC_APP_URL or command argument (e.g. node scripts/set_webhook.js https://your-app.vercel.app)');
  process.exit(1);
}

async function main() {
  console.log('Setting Telegram webhook to:', webhookUrl);
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
  const json = await res.json();
  console.log('Set Webhook Result:', json);

  const infoRes = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  const infoJson = await infoRes.json();
  console.log('Current Webhook Info:', infoJson);
}

main();
