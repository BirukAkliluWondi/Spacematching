const botToken = '8415131791:AAFQ1ozuyXyxPm3Zdr50T9gqeR8sVeoQNS4';

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${botToken}/getWebhookInfo`);
  const json = await res.json();
  console.log('Webhook Info:', json);
}

main();
