const fs = require('fs')
const lines = fs.readFileSync('.env.local','utf8').split('\n')
const env = {}
lines.forEach(l => { const i = l.indexOf('='); if(i>0) env[l.slice(0,i).trim()] = l.slice(i+1).trim().replace(/^["']|["']$/g,'') })
const url = env['NEXT_PUBLIC_SUPABASE_URL']
const key = env['SUPABASE_SERVICE_ROLE_KEY']

async function check() {
  const r = await fetch(url+'/rest/v1/dev_uploads?select=id,periodo,status,error_msg,uploaded_at,processed_at&order=uploaded_at.desc&limit=5',
    {headers:{apikey:key,Authorization:'Bearer '+key}})
  const d = await r.json()
  const now = new Date().toISOString().slice(11,19)
  d.forEach(u => {
    const upAt = (u.uploaded_at||'').slice(11,19)
    const procAt = (u.processed_at||'').slice(11,19)
    const elapsed = u.uploaded_at ? Math.round((Date.now()-new Date(u.uploaded_at))/1000) : '?'
    const msg = (u.error_msg||'').slice(0,50)
    console.log('['+now+'] '+(u.status||'').padEnd(12)+' '+u.periodo+' up:'+upAt+' proc:'+(procAt||'--:--:--')+' +'+elapsed+'s  '+msg)
  })
  console.log('---')
}

check()
const t = setInterval(check, 10000)
setTimeout(function(){ clearInterval(t); process.exit(0) }, 300000)
