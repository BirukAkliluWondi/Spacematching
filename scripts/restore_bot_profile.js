const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is missing.');
  process.exit(1);
}

async function callTelegram(method, payload) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return data;
    } catch (err) {
      console.warn(`Attempt ${attempt} for ${method} failed:`, err.message);
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function main() {
  console.log('Updating Telegram Bot Name to SpaceMatch Addis...');

  // Set Bot Name
  const nameRes = await callTelegram('setMyName', { name: 'SpaceMatch Addis' });
  console.log('setMyName result:', nameRes);

  // Set Description
  const descRes = await callTelegram('setMyDescription', {
    description: '🏠 SpaceMatch Addis - ባለ 1 መኝታ፣ ስቱዲዮና የጋራ ክፍሎችን በአዲስ አበባ በቀላሉ ያግኙ ወይም ቤትዎን ያከራዩ!',
  });
  console.log('setMyDescription result:', descRes);

  // Set Short Description
  const shortDescRes = await callTelegram('setMyShortDescription', {
    short_description: '🏠 SpaceMatch Addis - ክፍሎችን በቦሌ፣ ካዛንችስና አዲስ አበባ ያግኙ ወይም ያከራዩ!',
  });
  console.log('setMyShortDescription result:', shortDescRes);
}

main();
