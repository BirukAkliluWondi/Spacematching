const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

async function main() {
  console.log('Registering Telegram Bot Commands...');

  const commands = [
    { command: 'start', description: '👥 Roommate Matching & Main Menu' },
    { command: 'seeker', description: '👥 Post Roommate Seeker Profile' },
    { command: 'post', description: '🏠 List Space / Room for Rent' },
    { command: 'verify', description: '🛡️ Verify Fayda National ID' },
    { command: 'myorders', description: '📂 View My Unlocked Contact Details' },
    { command: 'browse', description: '📱 Open SpaceMatch Mini App' },
    { command: 'match', description: '🎯 Search Roommates & Rooms by Sub-city' },
    { command: 'help', description: '❓ Platform Instructions & Guide' },
    { command: 'support', description: '💬 Contact Admin Support' },
    { command: 'admin', description: '👑 Admin Approval & Control Panel' },
    { command: 'cancel', description: '❌ Cancel Current Action' },
    { command: 'stats', description: '📊 System Analytics (Admin)' },
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
