const botToken = '8415131791:AAFQ1ozuyXyxPm3Zdr50T9gqeR8sVeoQNS4';
const webhookUrl = 'https://cd9e-196-189-152-158.ngrok-free.app/api/telegram/webhook';

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
