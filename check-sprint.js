require('dotenv/config');
const { LinearClient } = require('@linear/sdk');
const linear = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

async function run() {
  const issue = await linear.issue('GROW-6');
  const cycle = await issue.cycle;
  console.log('GROW-6 cycle:', cycle ? `${cycle.name} (${cycle.startsAt?.toISOString()?.split('T')[0]} → ${cycle.endsAt?.toISOString()?.split('T')[0]})` : 'none');
}
run().catch(console.error);
