const botToken = process.env.TELEGRAM_BOT_TOKEN;
const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.argv[2];

if (!botToken || !appUrl) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN and appUrl (via NEXT_PUBLIC_APP_URL or argument) are required.');
  process.exit(1);
}

async function main() {
  console.log('Updating Telegram Bot Menu Button to:', appUrl);
  
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      menu_button: {
        type: 'web_app',
        text: '🔍 Open RoomMatch',
        web_app: { url: appUrl }
      }
    })
  });
  
  const json = await res.json();
  console.log('setChatMenuButton result:', json);

  const getRes = await fetch(`https://api.telegram.org/bot${botToken}/getChatMenuButton`);
  const getJson = await getRes.json();
  console.log('getChatMenuButton current config:', getJson);
}

main();
