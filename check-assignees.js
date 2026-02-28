require('dotenv/config');
const axios = require('axios');
const auth = Buffer.from(process.env.JIRA_EMAIL + ':' + process.env.JIRA_API_TOKEN).toString('base64');
const http = axios.create({
  baseURL: process.env.JIRA_BASE_URL.replace(/\/$/, '') + '/rest/api/3',
  headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' }
});

const failedKeys = ['EM-1','EM-3','EM-4','EM-5','EM-6','EM-7','EM-8','EM-9','EM-13','EM-17','EM-18','EM-19','EM-20','EM-21','EM-22','EM-24','EM-32','EM-35','EM-36','EM-39','EM-40','EM-41','EM-42','EM-45','EM-46','EM-47','EM-48','EM-49','EM-50','EM-56','EM-57','EM-58','EM-60','EM-61','EM-62','EM-63','EM-64','EM-65','EM-66','EM-67','EM-68','EM-69','EM-70','EM-71','EM-74','EM-75','EM-77','EM-78','EM-79','EM-84','EM-85'];

async function run() {
  const assignees = {};
  for (const key of failedKeys) {
    const r = await http.get('/issue/' + key, { params: { fields: 'assignee,summary' } });
    const a = r.data.fields.assignee;
    const name = a ? a.displayName + ' (' + (a.emailAddress || 'no email') + ')' : '(unassigned)';
    if (!assignees[name]) assignees[name] = [];
    assignees[name].push(key);
  }
  console.log('Assignees for the 51 failed tickets:\n');
  for (const [person, keys] of Object.entries(assignees)) {
    console.log(`  ${person}`);
    console.log(`    ${keys.join(', ')}\n`);
  }
}
run().catch(console.error);
