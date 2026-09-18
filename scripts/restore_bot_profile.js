const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

async function main() {
  console.log('Restoring Telegram Bot Name and Description...');

  // Set Bot Name
  const nameRes = await fetch(`https://api.telegram.org/bot${botToken}/setMyName`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'SpaceMatch Ethiopia' }),
  });
  console.log('setMyName result:', await nameRes.json());

  // Set Description
  const descRes = await fetch(`https://api.telegram.org/bot${botToken}/setMyDescription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: '🏠 SpaceMatch Ethiopia - ባለ 1 መኝታ፣ ስቱዲዮና የጋራ ክፍሎችን በአዲስ አበባ በቀላሉ ያግኙ ወይም ቤትዎን ያከራዩ!',
    }),
  });
  console.log('setMyDescription result:', await descRes.json());

  // Set Short Description
  const shortDescRes = await fetch(`https://api.telegram.org/bot${botToken}/setMyShortDescription`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      short_description: '🏠 SpaceMatch Ethiopia - ክፍሎችን በቦሌ፣ ካዛንችስና አዲስ አበባ ያግኙ ወይም ያከራዩ!',
    }),
  });
  console.log('setMyShortDescription result:', await shortDescRes.json());
}

main();
