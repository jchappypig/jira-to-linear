require('dotenv/config');
const { LinearClient } = require('@linear/sdk');
const client = new LinearClient({ apiKey: process.env.LINEAR_API_KEY });

async function run() {
  // Load all teams and check their cycles
  const teams = await client.teams({ first: 50 });
  for (const team of teams.nodes) {
    const cycles = await team.cycles({ first: 20 });
    if (cycles.nodes.length > 0) {
      console.log('\nTeam:', team.name, '(' + team.id + ')');
      for (const c of cycles.nodes) {
        console.log(' ', c.number, '-', c.name || '(no name)', '| start:', c.startsAt?.toISOString()?.split('T')[0], '| end:', c.endsAt?.toISOString()?.split('T')[0], '| id:', c.id);
      }
    }
  }
}
run().catch(console.error);
