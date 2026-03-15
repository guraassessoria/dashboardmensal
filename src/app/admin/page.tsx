'use client'

import { useState, useRef } from 'react'

export default function AdminPage() {
  const [password, setPassword] = useState('')
  const [authed, setAuthed] = useState(false)
  const [authError, setAuthError] = useState('')

  const [file, setFile] = useState<File | null>(null)
  const [tipoDoc, setTipoDoc] = useState<'dfs'|'balancete'>('dfs')
  const [periodo, setPeriodo] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [uploads, setUploads] = useState<any[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  // ── Autenticação simples ──
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    })
    if (res.ok) {
      setAuthed(true)
      loadHistory()
    } else {
      setAuthError('Senha incorreta')
    }
  }

  // ── Carregar histórico de uploads ──
  async function loadHistory() {
    const res = await fetch('/api/uploads')
    if (res.ok) {
      const data = await res.json()
      setUploads(data)
    }
  }

  // ── Upload do arquivo ──
  async function handleUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!file) return

    setStatus('uploading')
    setMessage('Enviando arquivo...')

    const formData = new FormData()
    formData.append('file', file)
    formData.append('periodo', periodo)
    formData.append('tipo_documento', tipoDoc)

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Erro no upload')
      }

      const data = await res.json()
      setStatus('processing')
      setMessage(`Arquivo enviado! Processando com IA... (ID: ${data.upload_id})`)

      // Polling do status
      pollStatus(data.upload_id)

    } catch (err: any) {
      setStatus('error')
      setMessage(`Erro: ${err.message}`)
    }
  }

  async function pollStatus(uploadId: string) {
    const interval = setInterval(async () => {
      const res = await fetch(`/api/upload-status?id=${uploadId}`)
      const data = await res.json()

      if (data.status === 'done') {
        clearInterval(interval)
        setStatus('done')
        setMessage('✅ Dashboard atualizado com sucesso! O Vercel irá redesployer automaticamente.')
        setFile(null)
        if (fileRef.current) fileRef.current.value = ''
        loadHistory()
      } else if (data.status === 'error') {
        clearInterval(interval)
        setStatus('error')
        setMessage(`❌ Erro no processamento: ${data.error_msg}`)
      }
    }, 3000) // Check a cada 3s
  }

  if (!authed) {
    return (
      <div style={styles.page}>
        <div style={styles.loginBox}>
          <div style={styles.logo}>CBF</div>
          <h1 style={styles.loginTitle}>Dashboard Admin</h1>
          <p style={styles.loginSub}>Acesso restrito à equipe autorizada</p>
          <form onSubmit={handleLogin} style={styles.form}>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Senha de acesso"
              style={styles.input}
              autoFocus
            />
            {authError && <p style={styles.error}>{authError}</p>}
            <button type="submit" style={styles.btn}>Entrar</button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        {/* Header */}
        <div style={styles.header}>
          <div>
            <div style={styles.headerLabel}>// ADMIN</div>
            <h1 style={styles.headerTitle}>CBF Dashboard · Upload de Dados</h1>
          </div>
          <a href="/" style={styles.viewBtn}>Ver Dashboard →</a>
        </div>

        {/* Upload Form */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>📤 Novo Upload Mensal</h2>
          <p style={styles.cardSub}>
            Faça o upload do xlsx de DFS. A IA irá extrair os dados automaticamente e atualizar o dashboard.
          </p>

          <form onSubmit={handleUpload} style={styles.uploadForm}>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Período de referência</label>
              <input
                type="month"
                value={periodo}
                onChange={e => setPeriodo(e.target.value)}
                style={styles.input}
                required
              />
            </div>

            <div style={styles.fieldGroup}>
              <label style={styles.label}>Tipo de documento</label>
              <div style={{display:'flex', gap:12}}>
                {['dfs','balancete'].map(t => (
                  <label key={t} style={{display:'flex',alignItems:'center',gap:6,cursor:'pointer',fontSize:13,color:'#FAFAFA'}}>
                    <input
                      type="radio"
                      name="tipo"
                      value={t}
                      checked={tipoDoc === t}
                      onChange={() => setTipoDoc(t as 'dfs'|'balancete')}
                      style={{accentColor:'#F5C800'}}
                    />
                    {t === 'dfs' ? '📊 DFS Anual' : '📋 Balancete Mensal'}
                  </label>
                ))}
              </div>
              <p style={{fontSize:11,color:'#8B949E',margin:'4px 0 0'}}>
                {tipoDoc === 'dfs'
                  ? 'Demonstrações Financeiras completas (anual)'
                  : 'Balancete mensal — valores acumulados do ano até o mês'}
              </p>
            </div>

            <div style={styles.fieldGroup}>
              <label style={styles.label}>Arquivo {tipoDoc === 'dfs' ? 'DFS' : 'Balancete'} (xlsx)</label>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.docx"
                onChange={e => setFile(e.target.files?.[0] || null)}
                style={styles.fileInput}
                required
              />
              {file && (
                <p style={styles.fileName}>
                  📎 {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)
                </p>
              )}
            </div>

            <button
              type="submit"
              style={{
                ...styles.btn,
                opacity: status === 'uploading' || status === 'processing' ? 0.6 : 1,
                cursor: status === 'uploading' || status === 'processing' ? 'not-allowed' : 'pointer'
              }}
              disabled={status === 'uploading' || status === 'processing'}
            >
              {status === 'uploading' ? '⏳ Enviando...' :
               status === 'processing' ? '🤖 IA Processando...' :
               '🚀 Enviar e Processar'}
            </button>
          </form>

          {/* Status Message */}
          {message && (
            <div style={{
              ...styles.statusBox,
              borderColor: status === 'done' ? '#3FB950' :
                           status === 'error' ? '#F85149' : '#F5C800',
              background: status === 'done' ? 'rgba(63,185,80,.08)' :
                          status === 'error' ? 'rgba(248,81,73,.08)' : 'rgba(245,200,0,.08)'
            }}>
              {status === 'processing' && (
                <div style={styles.spinner}>
                  <div style={styles.spinnerInner}></div>
                </div>
              )}
              <p style={{ color: '#fff', margin: 0, fontSize: 14 }}>{message}</p>
            </div>
          )}
        </div>

        {/* Histórico */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>📋 Histórico de Uploads</h2>
          {uploads.length === 0 ? (
            <p style={{ color: '#8B949E', fontSize: 13 }}>Nenhum upload registrado ainda.</p>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  {['Período', 'Arquivo', 'Status', 'Enviado em', 'Processado em'].map(h => (
                    <th key={h} style={styles.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {uploads.map((u: any) => (
                  <tr key={u.id}>
                    <td style={styles.td}><strong>{u.periodo}</strong></td>
                    <td style={styles.td}>{u.filename}</td>
                    <td style={styles.td}>
                      <span style={{
                        ...styles.badge,
                        background: u.status === 'done' ? 'rgba(63,185,80,.15)' :
                                    u.status === 'error' ? 'rgba(248,81,73,.15)' : 'rgba(245,200,0,.15)',
                        color: u.status === 'done' ? '#3FB950' :
                               u.status === 'error' ? '#F85149' : '#F5C800'
                      }}>
                        {u.status === 'done' ? '✅ Concluído' :
                         u.status === 'error' ? '❌ Erro' :
                         u.status === 'processing' ? '⏳ Processando' : '⏸ Pendente'}
                      </span>
                    </td>
                    <td style={styles.td}>{new Date(u.uploaded_at).toLocaleString('pt-BR')}</td>
                    <td style={styles.td}>
                      {u.processed_at ? new Date(u.processed_at).toLocaleString('pt-BR') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

// ── Estilos inline (sem Tailwind para manter zero-deps) ──
const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh', background: '#0D1117', color: '#FAFAFA',
    fontFamily: "'DM Sans', system-ui, sans-serif", padding: 0, margin: 0
  },
  loginBox: {
    maxWidth: 400, margin: '0 auto', paddingTop: 120, textAlign: 'center'
  },
  logo: {
    fontFamily: 'Georgia, serif', fontSize: 48, fontWeight: 700,
    color: '#F5C800', letterSpacing: 4, marginBottom: 16
  },
  loginTitle: { fontSize: 22, fontWeight: 600, marginBottom: 8, color: '#FAFAFA' },
  loginSub: { fontSize: 13, color: '#8B949E', marginBottom: 32 },
  form: { display: 'flex', flexDirection: 'column', gap: 12 },
  input: {
    background: '#161B22', border: '1px solid rgba(255,255,255,.12)',
    borderRadius: 8, padding: '12px 16px', color: '#FAFAFA',
    fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box'
  },
  error: { color: '#F85149', fontSize: 13, margin: 0 },
  btn: {
    background: '#F5C800', color: '#000', border: 'none',
    borderRadius: 8, padding: '12px 24px', fontSize: 14,
    fontWeight: 700, cursor: 'pointer', width: '100%'
  },
  container: { maxWidth: 900, margin: '0 auto', padding: '40px 24px' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    marginBottom: 32
  },
  headerLabel: {
    fontFamily: 'monospace', fontSize: 11, color: '#F5C800',
    letterSpacing: 2, marginBottom: 6
  },
  headerTitle: { fontSize: 24, fontWeight: 700, margin: 0 },
  viewBtn: {
    color: '#F5C800', textDecoration: 'none', fontSize: 13,
    padding: '8px 16px', border: '1px solid rgba(245,200,0,.3)',
    borderRadius: 6
  },
  card: {
    background: 'rgba(22,27,34,.85)', border: '1px solid rgba(255,255,255,.08)',
    borderRadius: 12, padding: 28, marginBottom: 20
  },
  cardTitle: { fontSize: 16, fontWeight: 600, marginBottom: 6, marginTop: 0 },
  cardSub: { fontSize: 13, color: '#8B949E', marginBottom: 24 },
  uploadForm: { display: 'flex', flexDirection: 'column', gap: 18 },
  fieldGroup: { display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontSize: 12, color: '#8B949E', fontWeight: 500 },
  fileInput: {
    background: '#161B22', border: '1px dashed rgba(255,255,255,.2)',
    borderRadius: 8, padding: '16px', color: '#8B949E', fontSize: 13,
    cursor: 'pointer', width: '100%', boxSizing: 'border-box'
  },
  fileName: { fontSize: 12, color: '#3FB950', margin: '4px 0 0' },
  statusBox: {
    marginTop: 16, padding: '14px 18px', borderRadius: 8,
    border: '1px solid', display: 'flex', alignItems: 'center', gap: 12
  },
  spinner: { width: 20, height: 20, flexShrink: 0 },
  spinnerInner: {
    width: 20, height: 20, border: '2px solid rgba(245,200,0,.3)',
    borderTop: '2px solid #F5C800', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite'
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th: {
    textAlign: 'left', padding: '8px 12px', fontSize: 11,
    color: '#8B949E', borderBottom: '1px solid rgba(255,255,255,.08)',
    fontWeight: 500, textTransform: 'uppercase', letterSpacing: 1
  },
  td: {
    padding: '11px 12px', borderBottom: '1px solid rgba(255,255,255,.04)',
    color: 'rgba(255,255,255,.8)'
  },
  badge: {
    display: 'inline-block', padding: '3px 10px', borderRadius: 100,
    fontSize: 11, fontWeight: 600
  }
}
