const botToken = process.env.TELEGRAM_BOT_TOKEN;
const isWebApp = process.argv.includes('--webapp');
const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.argv.find(a => a.startsWith('http'));

if (!botToken) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is required.');
  process.exit(1);
}

async function main() {
  const menuButton = isWebApp && appUrl
    ? {
        type: 'web_app',
        text: '🔍 Open SpaceMatch',
        web_app: { url: appUrl },
      }
    : {
        type: 'commands',
      };

  console.log('Configuring Telegram Bot Menu Button to:', JSON.stringify(menuButton));

  const res = await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ menu_button: menuButton }),
  });

  const json = await res.json();
  console.log('setChatMenuButton result:', json);

  const getRes = await fetch(`https://api.telegram.org/bot${botToken}/getChatMenuButton`);
  const getJson = await getRes.json();
  console.log('getChatMenuButton current config:', getJson);
}

main();
