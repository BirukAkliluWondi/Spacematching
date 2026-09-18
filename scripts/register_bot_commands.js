const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

async function main() {
  console.log('Registering Telegram Bot Commands...');

  const commands = [
    { command: 'start', description: '🏠 SpaceMatch Addis main menu' },
    { command: 'property_type', description: '🏢 Select space type to list' },
    { command: 'my_gender', description: '👤 Select gender & roommate preference' },
    { command: 'my_age', description: '🎂 Select age bracket' },
    { command: 'upload_listing', description: '📸 Send photos & listing details' },
    { command: 'seeker_property_type', description: '🔍 Select space type you need' },
    { command: 'seeker_gender', description: '👤 Select seeker gender preference' },
    { command: 'seeker_age', description: '🎂 Select seeker age bracket' },
    { command: 'upload_seeker_profile', description: '📝 Send seeker preferences' },
    { command: 'match', description: '🎯 Find & match rooms by neighborhood & budget' },
    { command: 'browse', description: 'Open SpaceMatch Mini App storefront' },
    { command: 'myorders', description: 'View your unlocked room contacts' },
    { command: 'verify', description: 'Check Fayda National ID verification' },
    { command: 'help', description: 'User guide and platform instructions' },
    { command: 'support', description: 'Contact admin support team' },
    { command: 'admin', description: '[Admin] Channel post manager & controls' },
    { command: 'cancel', description: 'Cancel active process & return to menu' },
    { command: 'stats', description: '[Admin] View platform statistics' },
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
