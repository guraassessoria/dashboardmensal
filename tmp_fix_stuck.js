const fs = require('fs')
const lines = fs.readFileSync('.env.local','utf8').split('\n')
const env = {}
lines.forEach(l => { const i = l.indexOf('='); if(i>0) env[l.slice(0,i).trim()] = l.slice(i+1).trim().replace(/^["']|["']$/g,'') })
const url = env['NEXT_PUBLIC_SUPABASE_URL']
const key = env['SUPABASE_SERVICE_ROLE_KEY']

// Mark all stuck 'processing' uploads older than 3m as error
async function fixStuck() {
  const r = await fetch(url+'/rest/v1/dev_uploads?status=eq.processing&select=id,periodo,uploaded_at',
    {headers:{apikey:key,Authorization:'Bearer '+key}})
  const stuck = await r.json()
  console.log('Stuck:', stuck.length)
  for (const u of stuck) {
    const age = (Date.now() - new Date(u.uploaded_at)) / 1000
    console.log(`  ID=${u.id} periodo=${u.periodo} age=${Math.round(age)}s`)
    if (age > 180) {
      const upd = await fetch(url+'/rest/v1/dev_uploads?id=eq.'+u.id, {
        method: 'PATCH',
        headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json','Prefer':'return=minimal'},
        body: JSON.stringify({status:'error', error_msg:'Timeout: marcado manualmente (orfao)'})
      })
      console.log(`  → Marked as error: ${upd.status}`)
    }
  }
}
fixStuck().catch(e=>console.error(e.message))
