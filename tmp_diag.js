const fs = require('fs')
const lines = fs.readFileSync('.env.local','utf8').split('\n')
const env = {}
lines.forEach(l => { const i = l.indexOf('='); if(i>0) env[l.slice(0,i).trim()] = l.slice(i+1).trim().replace(/^["']|["']$/g,'') })
const url = env['NEXT_PUBLIC_SUPABASE_URL']
const key = env['SUPABASE_SERVICE_ROLE_KEY']

async function query(path) {
  const r = await fetch(url+path, {headers:{apikey:key,Authorization:'Bearer '+key}})
  return r.json()
}

async function main() {
  // 1. Most recent uploads
  console.log('\n=== DEV_UPLOADS (últimos 5) ===')
  const uploads = await query('/rest/v1/dev_uploads?select=id,periodo,status,error_msg,uploaded_at,processed_at&order=uploaded_at.desc&limit=5')
  uploads.forEach(u => {
    const age = u.uploaded_at ? Math.round((Date.now()-new Date(u.uploaded_at))/1000) : '?'
    console.log(`${(u.status||'').padEnd(12)} ${u.periodo} ${(u.uploaded_at||'').slice(11,19)} +${age}s\n  err: ${(u.error_msg||'nenhum').slice(0,100)}`)
  })

  // 2. dados_financeiros for 2025-01
  console.log('\n=== DEV_DADOS_FINANCEIROS (2025-01) ===')
  const dados = await query('/rest/v1/dev_dados_financeiros?select=periodo,updated_at,receita_bruta,result_exercicio,source_file&eq.periodo=2025-01')
  console.log(JSON.stringify(dados, null, 2))

  // 3. Check if dados_financeiros for 2025-01 actually has data
  const dadosFull = await query('/rest/v1/dev_dados_financeiros?periodo=eq.2025-01&select=periodo,updated_at,source_file,receita_bruta,custos_futebol,resultado_exercicio')
  console.log('\n=== DADOS 2025-01 ===')
  console.log(JSON.stringify(dadosFull, null, 2))
}

main().catch(e => console.error(e.message))
