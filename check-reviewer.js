require('dotenv/config');
const axios = require('axios');
const auth = Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64');
const http = axios.create({
  baseURL: process.env.JIRA_BASE_URL.replace(/\/$/, '') + '/rest/api/3',
  headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' }
});

async function run() {
  const r = await http.get('/issue/DEL-6608', { params: { fields: '*all' } });
  const fields = r.data.fields;
  // Print all non-null user-type fields
  console.log('All user fields on DEL-6608:');
  for (const [k, v] of Object.entries(fields)) {
    if (!v) continue;
    if (typeof v === 'object' && !Array.isArray(v) && v.emailAddress) {
      console.log(' ', k, ':', v.displayName, '(' + v.emailAddress + ')');
    }
    if (Array.isArray(v) && v.length > 0 && v[0] && v[0].emailAddress) {
      console.log(' ', k, '(array):', v.map(u => u.displayName + ' (' + u.emailAddress + ')').join(', '));
    }
  }
  // Print customfield_15000 raw
  console.log('\ncustomfield_15000 raw:', JSON.stringify(fields['customfield_15000']));
}
run().catch(console.error);
