const botToken = '8415131791:AAFQ1ozuyXyxPm3Zdr50T9gqeR8sVeoQNS4';
const appUrl = 'https://cd9e-196-189-152-158.ngrok-free.app';

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
