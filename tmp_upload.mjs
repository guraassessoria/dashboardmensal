import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'

const SUPABASE_URL = 'https://uqthbzqpsgfflljxepen.supabase.co'
const SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVxdGhienFwc2dmZmxsanhlcGVuIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MzUwOTIxNiwiZXhwIjoyMDg5MDg1MjE2fQ.r5TLSR4KqZelpAlcpzSydF0lB5kIc7ylSgmiC0nTMEk'

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

const files = [
  { path: 'C:\\Users\\luiz.gomes\\Documents\\GitHub\\DFS 2026-01.xlsx', filename: 'DFS 2026-01.xlsx', tipo: 'dfs' },
  { path: 'C:\\Users\\luiz.gomes\\Documents\\GitHub\\2026-01.xlsx', filename: '2026-01.xlsx', tipo: 'balancete' },
]

const periodo = '2026-01'

async function uploadAndProcess(file) {
  console.log(`\n=== Uploading ${file.filename} (${file.tipo}) ===`)

  // 1. Upload to storage
  const bytes = readFileSync(file.path)
  const ts = Date.now()
  const storagePath = `${periodo}/${ts}_${file.filename}`

  const { error: storageErr } = await supabase.storage
    .from('uploads-cbf')
    .upload(storagePath, bytes, { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', upsert: false })

  if (storageErr) throw new Error(`Storage error: ${storageErr.message}`)
  console.log(`  Storage: ${storagePath}`)

  // 2. Register in dev_uploads
  const uploadId = randomUUID()
  const { error: dbErr } = await supabase
    .from('dev_uploads')
    .insert({ id: uploadId, filename: file.filename, file_type: 'xlsx', storage_path: storagePath, periodo, tipo_documento: file.tipo, status: 'pending' })

  if (dbErr) throw new Error(`DB error: ${dbErr.message}`)
  console.log(`  Upload ID: ${uploadId}`)

  // 3. Invoke edge function
  console.log(`  Processing...`)
  const res = await fetch(`${SUPABASE_URL}/functions/v1/process-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ upload_id: uploadId, storage_path: storagePath, periodo, filename: file.filename, tipo_documento: file.tipo, env: 'dev' })
  })

  const result = await res.json()
  console.log(`  Result (${res.status}):`, JSON.stringify(result))

  // 4. Check final status
  const { data: row } = await supabase.from('dev_uploads').select('status,error_msg').eq('id', uploadId).single()
  console.log(`  Final status: ${row?.status}${row?.error_msg ? ' - ' + row.error_msg : ''}`)

  return { uploadId, status: row?.status }
}

// Process sequentially to avoid rate limits
try {
  const r1 = await uploadAndProcess(files[0])
  console.log('\nAguardando 10s para evitar rate limit...')
  await new Promise(r => setTimeout(r, 10000))
  const r2 = await uploadAndProcess(files[1])

  console.log('\n=== RESUMO ===')
  console.log(`DFS: ${r1.status}`)
  console.log(`Balancete: ${r2.status}`)

  // Check final data
  const { data } = await supabase.from('dev_dados_financeiros').select('periodo,receita_bruta,ativo_total,patrimonio_liquido').eq('periodo', periodo).single()
  console.log('Dados:', JSON.stringify(data))
} catch (e) {
  console.error('ERRO:', e.message)
}
