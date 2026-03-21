const url = 'https://uqthbzqpsgfflljxepen.supabase.co';
const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxdGhienFwc2dmZmxsanhlcGVuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzUwOTIxNiwiZXhwIjoyMDg5MDg1MjE2fQ.r5TLSR4KqZelpAlcpzSydF0lB5kIc7ylSgmiC0nTMEk';
const h = { 'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };

async function run() {
  // Create dev_uploads
  const r1 = await fetch(url + '/rest/v1/rpc/', {
    method: 'POST', headers: h,
    body: JSON.stringify({})
  });
  
  // We'll use the Supabase SQL Editor approach via the management API
  // Since rpc/exec_sql doesn't exist, let's use npx supabase db execute instead
  console.log("Use npx supabase to run SQL");
}

run();
