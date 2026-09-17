const { broadcastListingToChannel } = require('../src/lib/telegram-broadcast');

async function main() {
  const listingId = '73d7815e-c01b-4b0d-9bf4-9668cffcdd73';
  console.log('Testing channel broadcast for listing:', listingId);
  const result = await broadcastListingToChannel(listingId);
  console.log('Broadcast Result:', result);
}

main().catch(err => console.error(err));
