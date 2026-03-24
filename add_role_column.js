const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

(async () => {
  // Add role column
  const { data, error } = await sb.rpc('exec_sql', {
    sql_query: "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor'))"
  });

  if (error) {
    console.error('rpc exec_sql failed:', error.message);
    // Try direct REST approach
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL + '/rest/v1/rpc/exec_sql';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        sql_query: "ALTER TABLE dashboard_users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'editor' CHECK (role IN ('admin','editor'))"
      })
    });
    console.log('Direct REST:', res.status, await res.text());
  } else {
    console.log('OK - role column added');
  }

  // Set admin and luiz.gomes as admin
  const { error: e2 } = await sb
    .from('dashboard_users')
    .update({ role: 'admin' })
    .in('username', ['admin', 'luiz.gomes']);

  if (e2) console.error('Update role failed:', e2.message);
  else console.log('OK - admin/luiz.gomes set as admin');

  // Verify
  const { data: users } = await sb
    .from('dashboard_users')
    .select('username, role, ativo');
  console.table(users);
})();
