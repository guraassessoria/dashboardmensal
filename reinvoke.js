const { createClient } = require('@supabase/supabase-js');
const s = createClient(
  'https://uqthbzqpsgfflljxepen.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxdGhienFwc2dmZmxsanhlcGVuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzUwOTIxNiwiZXhwIjoyMDg5MDg1MjE2fQ.r5TLSR4KqZelpAlcpzSydF0lB5kIc7ylSgmiC0nTMEk'
);

async function main() {
  // Reset status to pending
  const { error: resetErr } = await s.from('dev_uploads')
    .update({ status: 'pending' })
    .eq('id', '057f0920-09bf-40a0-8b19-3a19d55d675b');
  
  if (resetErr) {
    console.log('Reset error:', resetErr.message);
    return;
  }
  console.log('Upload status reset to pending');

  // Invoke edge function
  const { data, error } = await s.functions.invoke('process-upload', {
    body: {
      upload_id: '057f0920-09bf-40a0-8b19-3a19d55d675b',
      filename: 'DFS 2026-01.xlsx',
      file_type: 'xlsx',
      storage_path: '2026-01/1774116926137_DFS 2026-01.xlsx',
      periodo: '2026-01',
      tipo_documento: 'dfs',
      env: 'dev'
    }
  });

  if (error) {
    console.log('Invoke error:', error.message);
  } else {
    console.log('Invoke result:', JSON.stringify(data));
  }

  // Check updated upload record
  const { data: upload } = await s.from('dev_uploads')
    .select('id,status,error_msg,processed_at')
    .eq('id', '057f0920-09bf-40a0-8b19-3a19d55d675b')
    .single();
  console.log('Upload after:', JSON.stringify(upload));

  // Check insights
  const { data: insights } = await s.from('dev_insights_gerados')
    .select('upload_id,updated_at')
    .eq('periodo', '2026-01')
    .single();
  console.log('Insights:', JSON.stringify(insights));
}

main().catch(e => console.error(e));
