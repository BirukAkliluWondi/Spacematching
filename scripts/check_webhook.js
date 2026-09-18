const botToken = process.env.TELEGRAM_BOT_TOKEN;
if (!botToken) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  const json = await res.json();
  console.log('Webhook Info:', json);
}

main();
