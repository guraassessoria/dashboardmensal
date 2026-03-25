const fs = require('fs')
const lines = fs.readFileSync('.env.local','utf8').split('\n')
const env = {}
lines.forEach(l => { const i = l.indexOf('='); if(i>0) env[l.slice(0,i).trim()] = l.slice(i+1).trim().replace(/^["']|["']$/g,'') })
const url = env['NEXT_PUBLIC_SUPABASE_URL']
const key = env['SUPABASE_SERVICE_ROLE_KEY']

fetch(url+'/rest/v1/dev_uploads?select=id,periodo,status,error_msg,uploaded_at,processed_at&order=uploaded_at.desc&limit=15',
  {headers:{apikey:key,Authorization:'Bearer '+key}})
  .then(r=>r.json())
  .then(d=>{
    console.log('STATUS       PERIODO   HORA_UP   HORA_PROC  DUR(s)  ERRO')
    console.log('-'.repeat(90))
    d.forEach(u=>{
      const upAt = (u.uploaded_at||'').slice(11,19)
      const procAt = (u.processed_at||'').slice(11,19)
      const dur = u.uploaded_at && u.processed_at
        ? Math.round((new Date(u.processed_at)-new Date(u.uploaded_at))/1000)
        : (u.uploaded_at ? Math.round((Date.now()-new Date(u.uploaded_at))/1000)+'s+' : '?')
      console.log(
        (u.status||'').padEnd(12),
        (u.periodo||'').padEnd(10),
        upAt.padEnd(10),
        procAt.padEnd(10),
        String(dur).padEnd(8),
        (u.error_msg||'').slice(0,50)
      )
    })
  })
  .catch(e=>console.error(e.message))
