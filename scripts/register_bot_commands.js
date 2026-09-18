const botToken = '8415131791:AAFQ1ozuyXyxPm3Zdr50T9gqeR8sVeoQNS4';

async function main() {
  console.log('Registering Telegram Bot Commands...');

  const commands = [
    { command: 'start', description: 'Welcome screen and main menu' },
    { command: 'browse', description: 'Open SpaceMatch Mini App storefront' },
    { command: 'post', description: 'List a room/space for rent' },
    { command: 'myorders', description: 'View your unlocked room contacts' },
    { command: 'verify', description: 'Check Fayda National ID verification' },
    { command: 'help', description: 'User guide and platform instructions' },
    { command: 'support', description: 'Contact admin support team' },
    { command: 'stats', description: '[Admin] View platform statistics' },
    { command: 'broadcast', description: '[Admin] Broadcast listing to channel' },
  ];

  const res = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });

  const json = await res.json();
  console.log('setMyCommands result:', json);

  const getRes = await fetch(`https://api.telegram.org/bot${botToken}/getMyCommands`);
  const getJson = await getRes.json();
  console.log('getMyCommands current config:', getJson);
}

main();
