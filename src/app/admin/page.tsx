'use client'

import { useState, useRef, useEffect } from 'react'

interface DashUser {
  id: string
  username: string
  nome_completo: string | null
  ativo: boolean
  role?: string
  created_at: string
  updated_at?: string
}

export default function AdminPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authed, setAuthed] = useState(false)
  const [authError, setAuthError] = useState('')
  const [authRole, setAuthRole] = useState('')
  const [activeTab, setActiveTab] = useState<'upload' | 'tabelas' | 'users' | 'insights'>('upload')

  const [file, setFile] = useState<File | null>(null)
  const [periodo, setPeriodo] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [status, setStatus] = useState<'idle' | 'uploading' | 'processing' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [uploads, setUploads] = useState<any[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  // ── User Management State ──
  const [users, setUsers] = useState<DashUser[]>([])
  const [usersLoading, setUsersLoading] = useState(false)
  const [userMsg, setUserMsg] = useState('')
  const [newUser, setNewUser] = useState({ username: '', password: '', nome_completo: '', role: 'editor' })
  const [editingUser, setEditingUser] = useState<string | null>(null)
  const [editFields, setEditFields] = useState({ password: '', nome_completo: '', ativo: true, role: 'editor' })

  // ── Tabela Complementar State ──
  const [tcFile, setTcFile] = useState<File | null>(null)
  const [tcPeriodo, setTcPeriodo] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [tcStatus, setTcStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [tcMessage, setTcMessage] = useState('')
  const [tcTabelas, setTcTabelas] = useState<any[]>([])
  const tcFileRef = useRef<HTMLInputElement>(null)

  // ── Balancete Avulso State ──
  const [balFile, setBalFile] = useState<File | null>(null)
  const [balPeriodo, setBalPeriodo] = useState('2024-01')
  const [balStatus, setBalStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [balMsg, setBalMsg] = useState('')
  const balFileRef = useRef<HTMLInputElement>(null)
  const [insPeriodos, setInsPeriodos] = useState<{periodo:string,updated_at:string}[]>([])
  const [insPeriodo, setInsPeriodo] = useState('')
  const [insConteudo, setInsConteudo] = useState<Record<string,any>>({})
  const [insLoading, setInsLoading] = useState(false)
  const [insSaving, setInsSaving] = useState(false)
  const [insMsg, setInsMsg] = useState('')

  // ── Insights CRUD ──
  async function loadInsPeriodos() {
    const res = await fetch('/api/insights')
    if (res.ok) {
      const data = await res.json()
      setInsPeriodos(data)
      if (data.length > 0 && !insPeriodo) {
        loadInsight(data[0].periodo)
      }
    }
  }

  async function loadInsight(per: string) {
    setInsPeriodo(per)
    setInsLoading(true)
    setInsMsg('')
    try {
      const res = await fetch(`/api/insights?periodo=${per}`)
      if (res.ok) {
        const d = await res.json()
        setInsConteudo(d.conteudo || {})
      } else {
        setInsConteudo({})
        setInsMsg('Nenhum insight encontrado para este período.')
      }
    } finally {
      setInsLoading(false)
    }
  }

  async function saveInsights() {
    setInsSaving(true)
    setInsMsg('')
    try {
      const res = await fetch('/api/insights', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periodo: insPeriodo, conteudo: insConteudo })
      })
      if (res.ok) {
        setInsMsg('✅ Insights salvos com sucesso!')
      } else {
        const err = await res.json()
        setInsMsg(`❌ ${err.error}`)
      }
    } finally {
      setInsSaving(false)
    }
  }

  function setInsField(path: string, value: string) {
    setInsConteudo(prev => {
      const copy = { ...prev }
      const parts = path.split('.')
      if (parts.length === 1) {
        copy[parts[0]] = value
      } else if (parts.length === 2) {
        copy[parts[0]] = { ...(copy[parts[0]] || {}), [parts[1]]: value }
      } else if (parts.length === 3) {
        copy[parts[0]] = { ...(copy[parts[0]] || {}) }
        copy[parts[0]][parts[1]] = { ...(copy[parts[0]][parts[1]] || {}), [parts[2]]: value }
      }
      return copy
    })
  }

  function getInsField(path: string): string {
    const parts = path.split('.')
    let v: any = insConteudo
    for (const p of parts) {
      if (!v) return ''
      v = v[p]
    }
    return typeof v === 'string' ? v : ''
  }

  // ── User CRUD ──
  async function loadUsers() {
    setUsersLoading(true)
    try {
      const res = await fetch('/api/users')
      if (res.ok) setUsers(await res.json())
    } finally {
      setUsersLoading(false)
    }
  }

  async function createUser(e: React.FormEvent) {
    e.preventDefault()
    setUserMsg('')
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser)
    })
    if (res.ok) {
      setNewUser({ username: '', password: '', nome_completo: '', role: 'editor' })
      setUserMsg('✅ Usuário criado com sucesso')
      loadUsers()
    } else {
      const err = await res.json()
      setUserMsg(`❌ ${err.error}`)
    }
  }

  async function updateUser(id: string) {
    setUserMsg('')
    const body: Record<string, unknown> = { id }
    if (editFields.password) body.password = editFields.password
    if (editFields.nome_completo !== undefined) body.nome_completo = editFields.nome_completo
    body.ativo = editFields.ativo
    if (editFields.role) body.role = editFields.role

    const res = await fetch('/api/users', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    if (res.ok) {
      setEditingUser(null)
      setUserMsg('✅ Usuário atualizado')
      loadUsers()
    } else {
      const err = await res.json()
      setUserMsg(`❌ ${err.error}`)
    }
  }

  async function deleteUser(id: string, username: string) {
    if (!confirm(`Tem certeza que deseja excluir o usuário "${username}"?`)) return
    setUserMsg('')
    const res = await fetch('/api/users', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    if (res.ok) {
      setUserMsg('✅ Usuário excluído')
      loadUsers()
    } else {
      const err = await res.json()
      setUserMsg(`❌ ${err.error}`)
    }
  }

  // ── Tabela Complementar CRUD ──
  async function loadTcTabelas() {
    try {
      const res = await fetch('/api/upload-tabela')
      if (res.ok) setTcTabelas(await res.json())
    } catch {}
  }

  async function handleTcUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!tcFile) return

    setTcStatus('uploading')
    setTcMessage('Processando planilha...')

    const formData = new FormData()
    formData.append('file', tcFile)
    formData.append('periodo', tcPeriodo)

    try {
      const res = await fetch('/api/upload-tabela', {
        method: 'POST',
        body: formData
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Erro no upload')
      }

      const msgs = [`✅ ${data.tabelas} tabela(s) processada(s):`]
      if (data.resultados) msgs.push(...data.resultados)
      if (data.erros) msgs.push('', '⚠️ Avisos:', ...data.erros)

      setTcStatus('done')
      setTcMessage(msgs.join('\n'))
      setTcFile(null)
      if (tcFileRef.current) tcFileRef.current.value = ''
      loadTcTabelas()

    } catch (err: any) {
      setTcStatus('error')
      setTcMessage(`❌ ${err.message}`)
    }
  }

  async function deleteTcTabela(id: string, titulo: string) {
    if (!confirm(`Excluir tabela "${titulo}"?`)) return
    const res = await fetch('/api/upload-tabela', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    if (res.ok) {
      loadTcTabelas()
    }
  }

  // ── Autenticação por usuário ──
  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setAuthError('')
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    if (res.ok) {
      const data = await res.json()
      setAuthed(true)
      setAuthRole(data.role || 'editor')
      loadHistory()
      loadUsers()
    } else {
      const err = await res.json()
      setAuthError(err.error || 'Usuário ou senha incorretos')
    }
  }

  // ── Balancete Avulso Upload ──
  async function handleBalanceteUpload(e: React.FormEvent) {
    e.preventDefault()
    if (!balFile) return
    setBalStatus('uploading')
    setBalMsg('⏳ Enviando e processando balancete...')
    const formData = new FormData()
    formData.append('file', balFile)
    formData.append('periodo', balPeriodo)
    formData.append('tipo_documento', 'balancete')
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro no processamento')
      setBalFile(null)
      if (balFileRef.current) balFileRef.current.value = ''
      loadHistory()
      // Auto-avançar período até dez/2025
      const [ano, mes] = balPeriodo.split('-').map(Number)
      const nextMes = mes === 12 ? 1 : mes + 1
      const nextAno = mes === 12 ? ano + 1 : ano
      const next = `${nextAno}-${String(nextMes).padStart(2, '0')}`
      const msg = data.msg ? `✅ ${data.msg}` : `✅ Balancete ${balPeriodo} processado!`
      setBalMsg(next <= '2025-12' ? msg + ` — próximo: ${next}` : msg + ' — todos os períodos carregados!')
      setBalStatus(next <= '2025-12' ? 'idle' : 'done')
      if (next <= '2025-12') setBalPeriodo(next)
    } catch (err: any) {
      setBalStatus('error')
      setBalMsg(`❌ ${err.message}`)
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
    formData.append('tipo_documento', 'dfs')

    try {
      setStatus('processing')
      setMessage('⏳ Enviando e processando com IA... (pode levar até 60s)')

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Erro no processamento')
      }

      // Upload processado com sucesso — disparar insights em segundo plano
      setStatus('processing')
      setMessage('⚙️ Gerando insights analíticos...')
      try {
        const insRes = await fetch('/api/generate-insights', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ periodo: data.periodo || periodo, upload_id: data.upload_id })
        })
        if (insRes.ok) {
          setMessage('✅ Dashboard atualizado com sucesso! O Vercel irá redesployer automaticamente.')
        } else {
          setMessage('✅ Dashboard atualizado! (insights não gerados — edite manualmente)')
        }
      } catch {
        setMessage('✅ Dashboard atualizado! (insights pendentes — edite manualmente)')
      }
      setStatus('done')
      setFile(null)
      if (fileRef.current) fileRef.current.value = ''
      loadHistory()

    } catch (err: any) {
      setStatus('error')
      setMessage(`❌ Erro: ${err.message}`)
    }
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
              type="text"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="Usuário"
              style={styles.input}
              autoFocus
              autoComplete="username"
            />
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Senha"
              style={styles.input}
              autoComplete="current-password"
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
            <h1 style={styles.headerTitle}>CBF Dashboard · Administração</h1>
          </div>
          <a href="/" style={styles.viewBtn}>Ver Dashboard →</a>
        </div>

        {/* Tabs */}
        <div style={styles.tabs}>
          <button
            style={activeTab === 'upload' ? styles.tabActive : styles.tab}
            onClick={() => setActiveTab('upload')}
          >📤 Upload de Dados</button>
          {authRole === 'admin' && (
          <button
            style={activeTab === 'users' ? styles.tabActive : styles.tab}
            onClick={() => { setActiveTab('users'); loadUsers() }}
          >👥 Gerenciar Usuários</button>
          )}
          <button
            style={activeTab === 'insights' ? styles.tabActive : styles.tab}
            onClick={() => { setActiveTab('insights'); loadInsPeriodos() }}
          >✏️ Editar Insights</button>
          <button
            style={activeTab === 'tabelas' ? styles.tabActive : styles.tab}
            onClick={() => { setActiveTab('tabelas'); loadTcTabelas() }}
          >📋 Tabelas Complementares</button>
        </div>

        {activeTab === 'upload' && (<>
        {/* Upload Form */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>📤 Novo Upload Mensal</h2>
          <p style={styles.cardSub}>
            Faça o upload do Balancete e das DFs do período. Ambos os arquivos se complementam para gerar os dados, insights e tabelas do dashboard. A IA irá extrair os dados automaticamente.
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
              <label style={styles.label}>Arquivo DFS (xlsx)</label>
              <p style={{fontSize:11,color:'#8B949E',margin:'0 0 8px'}}>
                Demonstrações Financeiras completas. Se o arquivo contiver uma aba de Balancete, ela será extraída automaticamente.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv,.docx"
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

        {/* Balancete Avulso */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>📊 Upload de Balancete Avulso</h2>
          <p style={styles.cardSub}>
            Para carregar o histórico de balancetes (jan/24 a dez/25). O período avança automaticamente após cada upload.
            Se o balancete do período já existir e não houver alterações, nenhum reprocessamento é feito.
          </p>
          <form onSubmit={handleBalanceteUpload} style={styles.uploadForm}>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Período</label>
              <input
                type="month"
                value={balPeriodo}
                onChange={e => { setBalPeriodo(e.target.value); setBalStatus('idle'); setBalMsg('') }}
                style={styles.input}
                min="2024-01"
                max="2025-12"
                required
              />
            </div>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Arquivo Balancete (xlsx)</label>
              <input
                ref={balFileRef}
                type="file"
                accept=".xlsx"
                onChange={e => setBalFile(e.target.files?.[0] || null)}
                style={styles.fileInput}
                required
              />
              {balFile && <p style={styles.fileName}>📎 {balFile.name} ({(balFile.size / 1024).toFixed(0)} KB)</p>}
            </div>
            <button
              type="submit"
              disabled={!balFile || balStatus === 'uploading'}
              style={{ ...styles.btn, background: balStatus === 'uploading' ? '#555' : '#238636', opacity: balStatus === 'uploading' ? 0.6 : 1 }}
            >
              {balStatus === 'uploading' ? '⏳ Processando...' : '📊 Enviar Balancete'}
            </button>
          </form>
          {balMsg && (
            <div style={{
              ...styles.statusBox,
              borderColor: balStatus === 'error' ? '#F85149' : '#3FB950',
              background: balStatus === 'error' ? 'rgba(248,81,73,.08)' : 'rgba(63,185,80,.08)'
            }}>
              <p style={{ color: '#fff', margin: 0, fontSize: 14 }}>{balMsg}</p>
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
                  {['Período', 'Tipo', 'Arquivo', 'Status', 'Enviado em', 'Processado em'].map(h => (
                    <th key={h} style={styles.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {uploads.map((u: any) => (
                  <tr key={u.id}>
                    <td style={styles.td}><strong>{u.periodo}</strong></td>
                    <td style={styles.td}>
                      <span style={{
                        ...styles.badge,
                        background: 'rgba(245,200,0,.12)',
                        color: '#F5C800'
                      }}>
                        📊 DFs
                      </span>
                    </td>
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
        </>)}

        {activeTab === 'tabelas' && (<>
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>📋 Upload de Tabela Complementar</h2>
          <p style={styles.cardSub}>
            Suba uma planilha .xlsx com dados complementares. Formato obrigatório:<br/>
            <strong>Coluna 1</strong> = Página (overview, receitas, despesas, balanco, bp, indicadores, historico)<br/>
            <strong>Coluna 2</strong> = Título da tabela/gráfico<br/>
            <strong>Colunas 3+</strong> = Dados que serão exibidos como tabela na página indicada
          </p>

          <form onSubmit={handleTcUpload} style={styles.uploadForm}>
            <div style={styles.fieldGroup}>
              <label style={styles.label}>Período de referência</label>
              <input
                type="month"
                value={tcPeriodo}
                onChange={e => setTcPeriodo(e.target.value)}
                style={styles.input}
                required
              />
            </div>

            <div style={styles.fieldGroup}>
              <label style={styles.label}>Arquivo xlsx</label>
              <input
                ref={tcFileRef}
                type="file"
                accept=".xlsx"
                onChange={e => setTcFile(e.target.files?.[0] || null)}
                style={styles.fileInput}
                required
              />
              {tcFile && (
                <p style={styles.fileName}>
                  📎 {tcFile.name} ({(tcFile.size / 1024 / 1024).toFixed(1)} MB)
                </p>
              )}
            </div>

            <button
              type="submit"
              style={{
                ...styles.btn,
                opacity: tcStatus === 'uploading' ? 0.6 : 1,
                cursor: tcStatus === 'uploading' ? 'not-allowed' : 'pointer'
              }}
              disabled={tcStatus === 'uploading'}
            >
              {tcStatus === 'uploading' ? '⏳ Processando...' : '📋 Enviar Tabela'}
            </button>
          </form>

          {tcMessage && (
            <div style={{...styles.statusBox, background: tcStatus === 'error' ? 'rgba(248,81,73,.1)' : 'rgba(63,185,80,.1)', color: tcStatus === 'error' ? '#F85149' : '#3FB950'}}>
              <p style={{whiteSpace:'pre-wrap'}}>{tcMessage}</p>
            </div>
          )}
        </div>

        {/* Tabelas existentes */}
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>Tabelas Complementares Existentes</h2>
          {tcTabelas.length === 0 ? (
            <p style={{color:'#8B949E',fontSize:13}}>Nenhuma tabela complementar cadastrada.</p>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Período</th>
                  <th style={styles.th}>Página</th>
                  <th style={styles.th}>Título</th>
                  <th style={styles.th}>Colunas</th>
                  <th style={styles.th}>Linhas</th>
                  <th style={styles.th}>Arquivo</th>
                  <th style={styles.th}>Ações</th>
                </tr>
              </thead>
              <tbody>
                {tcTabelas.map((t: any) => (
                  <tr key={t.id}>
                    <td style={styles.td}>{t.periodo}</td>
                    <td style={styles.td}><span style={{...styles.badge, background:'rgba(245,200,0,.12)', color:'#F5C800'}}>{t.pagina}</span></td>
                    <td style={styles.td}>{t.titulo}</td>
                    <td style={styles.td}>{t.colunas?.length || 0}</td>
                    <td style={styles.td}>{t.linhas?.length || 0}</td>
                    <td style={styles.td}>{t.filename || '—'}</td>
                    <td style={styles.td}>
                      <button
                        style={{...styles.btn, padding:'4px 10px', fontSize:11, background:'#F85149'}}
                        onClick={() => deleteTcTabela(t.id, t.titulo)}
                      >🗑 Excluir</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        </>)}

        {activeTab === 'users' && authRole === 'admin' && (
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>👥 Gerenciamento de Usuários</h2>
          <p style={styles.cardSub}>
            Crie, edite ou exclua logins de acesso ao dashboard.
          </p>

          {userMsg && (
            <div style={{
              padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13,
              background: userMsg.startsWith('✅') ? 'rgba(63,185,80,.1)' : 'rgba(248,81,73,.1)',
              color: userMsg.startsWith('✅') ? '#3FB950' : '#F85149',
              border: `1px solid ${userMsg.startsWith('✅') ? 'rgba(63,185,80,.3)' : 'rgba(248,81,73,.3)'}`
            }}>{userMsg}</div>
          )}

          {/* Criar novo usuário */}
          <form onSubmit={createUser} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 24 }}>
            <input
              placeholder="Usuário"
              value={newUser.username}
              onChange={e => setNewUser(p => ({ ...p, username: e.target.value }))}
              style={{ ...styles.input, flex: '1 1 140px' }}
              required
            />
            <input
              placeholder="Senha"
              type="password"
              value={newUser.password}
              onChange={e => setNewUser(p => ({ ...p, password: e.target.value }))}
              style={{ ...styles.input, flex: '1 1 140px' }}
              required
            />
            <input
              placeholder="Nome completo"
              value={newUser.nome_completo}
              onChange={e => setNewUser(p => ({ ...p, nome_completo: e.target.value }))}
              style={{ ...styles.input, flex: '2 1 200px' }}
            />
            <select
              value={newUser.role}
              onChange={e => setNewUser(p => ({ ...p, role: e.target.value }))}
              style={{ ...styles.input, flex: '0 0 120px', cursor: 'pointer' }}
            >
              <option value="admin">Admin</option>
              <option value="editor">Editor</option>
              <option value="consulta">Consulta</option>
            </select>
            <button type="submit" style={{ ...styles.btn, flex: '0 0 auto', width: 'auto', padding: '12px 20px' }}>
              + Criar
            </button>
          </form>

          {/* Lista de usuários */}
          {usersLoading ? (
            <p style={{ color: '#8B949E', fontSize: 13 }}>Carregando usuários...</p>
          ) : users.length === 0 ? (
            <p style={{ color: '#8B949E', fontSize: 13 }}>Nenhum usuário cadastrado.</p>
          ) : (
            <table style={styles.table}>
              <thead>
                <tr>
                  {['Usuário', 'Nome Completo', 'Perfil', 'Status', 'Criado em', 'Ações'].map(h => (
                    <th key={h} style={styles.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  editingUser === u.id ? (
                    <tr key={u.id}>
                      <td style={styles.td}><strong>{u.username}</strong></td>
                      <td style={styles.td}>
                        <input
                          value={editFields.nome_completo}
                          onChange={e => setEditFields(p => ({ ...p, nome_completo: e.target.value }))}
                          placeholder="Nome completo"
                          style={{ ...styles.input, padding: '6px 10px', fontSize: 12 }}
                        />
                      </td>
                      <td style={styles.td}>
                        <select
                          value={editFields.role}
                          onChange={e => setEditFields(p => ({ ...p, role: e.target.value }))}
                          style={{ ...styles.input, padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}
                        >
                          <option value="admin">Admin</option>
                          <option value="editor">Editor</option>
                          <option value="consulta">Consulta</option>
                        </select>
                      </td>
                      <td style={styles.td}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#FAFAFA', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={editFields.ativo}
                            onChange={e => setEditFields(p => ({ ...p, ativo: e.target.checked }))}
                            style={{ accentColor: '#F5C800' }}
                          /> Ativo
                        </label>
                        <input
                          type="password"
                          value={editFields.password}
                          onChange={e => setEditFields(p => ({ ...p, password: e.target.value }))}
                          placeholder="Nova senha (vazio = não alterar)"
                          style={{ ...styles.input, padding: '6px 10px', fontSize: 12, marginTop: 6 }}
                        />
                      </td>
                      <td style={styles.td}>{new Date(u.created_at).toLocaleDateString('pt-BR')}</td>
                      <td style={styles.td}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => updateUser(u.id)}
                            style={{ ...styles.actionBtn, background: 'rgba(63,185,80,.15)', color: '#3FB950' }}
                          >💾 Salvar</button>
                          <button
                            onClick={() => setEditingUser(null)}
                            style={{ ...styles.actionBtn, background: 'rgba(255,255,255,.08)', color: '#8B949E' }}
                          >Cancelar</button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={u.id}>
                      <td style={styles.td}><strong>{u.username}</strong></td>
                      <td style={styles.td}>{u.nome_completo || '—'}</td>
                      <td style={styles.td}>
                        <span style={{
                          ...styles.badge,
                          background: u.role === 'admin' ? 'rgba(245,200,0,.15)' : u.role === 'consulta' ? 'rgba(139,148,158,.15)' : 'rgba(63,185,80,.15)',
                          color: u.role === 'admin' ? '#F5C800' : u.role === 'consulta' ? '#8B949E' : '#3FB950'
                        }}>
                          {u.role === 'admin' ? '🔑 Admin' : u.role === 'consulta' ? '👁️ Consulta' : '✏️ Editor'}
                        </span>
                      </td>
                      <td style={styles.td}>
                        <span style={{
                          ...styles.badge,
                          background: u.ativo ? 'rgba(63,185,80,.15)' : 'rgba(248,81,73,.15)',
                          color: u.ativo ? '#3FB950' : '#F85149'
                        }}>
                          {u.ativo ? '✅ Ativo' : '❌ Inativo'}
                        </span>
                      </td>
                      <td style={styles.td}>{new Date(u.created_at).toLocaleDateString('pt-BR')}</td>
                      <td style={styles.td}>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => {
                              setEditingUser(u.id)
                              setEditFields({
                                password: '',
                                nome_completo: u.nome_completo || '',
                                ativo: u.ativo,
                                role: u.role || 'editor'
                              })
                            }}
                            style={{ ...styles.actionBtn, background: 'rgba(245,200,0,.12)', color: '#F5C800' }}
                          >✏️ Editar</button>
                          <button
                            onClick={() => deleteUser(u.id, u.username)}
                            style={{ ...styles.actionBtn, background: 'rgba(248,81,73,.12)', color: '#F85149' }}
                          >🗑️ Excluir</button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          )}
        </div>
        )}

        {activeTab === 'insights' && (
        <div style={styles.card}>
          <h2 style={styles.cardTitle}>✏️ Editor de Insights</h2>
          <p style={styles.cardSub}>
            Edite os textos e análises gerados pela IA para cada período.
          </p>

          {insMsg && (
            <div style={{
              padding: '10px 16px', borderRadius: 8, marginBottom: 16, fontSize: 13,
              background: insMsg.startsWith('✅') ? 'rgba(63,185,80,.1)' : 'rgba(248,81,73,.1)',
              color: insMsg.startsWith('✅') ? '#3FB950' : '#F85149',
              border: `1px solid ${insMsg.startsWith('✅') ? 'rgba(63,185,80,.3)' : 'rgba(248,81,73,.3)'}`
            }}>{insMsg}</div>
          )}

          {/* Seletor de período */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 24 }}>
            <label style={styles.label}>Período:</label>
            <select
              value={insPeriodo}
              onChange={e => loadInsight(e.target.value)}
              style={{ ...styles.input, width: 'auto', minWidth: 160 }}
            >
              {insPeriodos.length === 0 && <option value="">Nenhum período</option>}
              {insPeriodos.map(p => (
                <option key={p.periodo} value={p.periodo}>{p.periodo}</option>
              ))}
            </select>
            <button
              onClick={saveInsights}
              disabled={insSaving || !insPeriodo}
              style={{ ...styles.btn, width: 'auto', padding: '10px 24px', opacity: insSaving ? 0.6 : 1 }}
            >
              {insSaving ? '⏳ Salvando...' : '💾 Salvar Alterações'}
            </button>
          </div>

          {insLoading ? (
            <p style={{ color: '#8B949E', fontSize: 13 }}>Carregando insights...</p>
          ) : !insPeriodo ? (
            <p style={{ color: '#8B949E', fontSize: 13 }}>Selecione um período para editar.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {/* ── Resumo e Destaques ── */}
              <InsSection title="📊 Resumo Geral">
                <InsTextarea label="Resumo do Resultado (Déficit/Superávit)" path="resumo_deficit" get={getInsField} set={setInsField} />
                <InsTextarea label="Receitas em Destaque" path="receitas_destaque" get={getInsField} set={setInsField} />
                <InsTextarea label="Nike Banner" path="nike_banner" get={getInsField} set={setInsField} />
              </InsSection>

              {/* ── Custos por Seleção ── */}
              <InsSection title="⚽ Custos do Futebol">
                <InsTituloTexto label="Seleção Principal" prefixPath="custos_selecao_principal" get={getInsField} set={setInsField} />
                <InsTituloTexto label="Seleções de Base" prefixPath="custos_selecao_base" get={getInsField} set={setInsField} />
                <InsTituloTexto label="Seleções Femininas" prefixPath="custos_selecao_femininas" get={getInsField} set={setInsField} />
                <InsTituloTexto label="Fomento" prefixPath="custos_fomento" get={getInsField} set={setInsField} />
                <InsTextarea label="Alerta Despesas Administrativas" path="custos_admin_alerta" get={getInsField} set={setInsField} />
              </InsSection>

              {/* ── Balanço Patrimonial ── */}
              <InsSection title="🏦 Balanço Patrimonial">
                <InsTextarea label="Ativo" path="balanco_ativo" get={getInsField} set={setInsField} />
                <InsTextarea label="Passivo" path="balanco_passivo" get={getInsField} set={setInsField} />
                <InsTextarea label="Evolução Patrimonial" path="balanco_evolucao" get={getInsField} set={setInsField} />
              </InsSection>

              {/* ── Indicadores ── */}
              <InsSection title="📈 Indicadores Financeiros">
                <InsTextarea label="EBITDA" path="indicadores_ebitda" get={getInsField} set={setInsField} />
                <InsTextarea label="Índice de Kanitz" path="indicadores_kanitz" get={getInsField} set={setInsField} />
                <InsTextarea label="Liquidez Corrente" path="indicadores_liquidez_corrente" get={getInsField} set={setInsField} />
                <InsTextarea label="Liquidez Geral" path="indicadores_liquidez_geral" get={getInsField} set={setInsField} />
                <InsTextarea label="Liquidez Imediata" path="indicadores_liquidez_imediata" get={getInsField} set={setInsField} />
                <InsTextarea label="DFC (Fluxo de Caixa)" path="indicadores_dfc" get={getInsField} set={setInsField} />
                <InsTextarea label="Tendência" path="indicadores_tendencia" get={getInsField} set={setInsField} />
              </InsSection>

              {/* ── Histórico ── */}
              <InsSection title="🔮 Perspectiva">
                <InsTextarea label="Histórico e Perspectiva" path="historico_perspectiva" get={getInsField} set={setInsField} />
              </InsSection>

              {/* ── KPIs ── */}
              <InsSection title="🎯 KPIs (Cards do Topo)">
                {[
                  ['receita_bruta', 'Receita Bruta'],
                  ['resultado', 'Resultado do Exercício'],
                  ['custos_futebol', 'Custos do Futebol'],
                  ['caixa', 'Caixa e Equivalentes'],
                  ['ativo_total', 'Ativo Total'],
                  ['rec_financeiras', 'Receitas Financeiras'],
                  ['transmissao', 'Transmissão'],
                  ['patrocinio', 'Patrocínio'],
                  ['bilheteria', 'Bilheteria'],
                  ['registros', 'Registros'],
                  ['desenvolvimento', 'Desenvolvimento'],
                  ['fomento', 'Fomento'],
                  ['selecao_principal', 'Seleção Principal'],
                  ['selecao_femininas', 'Seleções Femininas'],
                  ['selecao_base', 'Seleções de Base'],
                  ['desp_administrativas', 'Desp. Administrativas'],
                  ['desp_pessoal', 'Desp. Pessoal'],
                ].map(([key, label]) => (
                  <InsKpi key={key} label={label} kpiKey={key} get={getInsField} set={setInsField} />
                ))}
              </InsSection>

              <button
                onClick={saveInsights}
                disabled={insSaving}
                style={{ ...styles.btn, opacity: insSaving ? 0.6 : 1, marginTop: 8 }}
              >
                {insSaving ? '⏳ Salvando...' : '💾 Salvar Todas as Alterações'}
              </button>
            </div>
          )}
        </div>
        )}
      </div>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

// ── Sub-componentes do Editor de Insights ──
function InsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ border: '1px solid rgba(255,255,255,.08)', borderRadius: 10, padding: 20 }}>
      <h3 style={{ fontSize: 14, fontWeight: 700, color: '#F5C800', marginTop: 0, marginBottom: 16 }}>{title}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
    </div>
  )
}

function InsTextarea({ label, path, get, set }: {
  label: string; path: string;
  get: (p: string) => string; set: (p: string, v: string) => void;
}) {
  return (
    <div>
      <label style={{ fontSize: 11, color: '#8B949E', fontWeight: 500, display: 'block', marginBottom: 4 }}>{label}</label>
      <textarea
        value={get(path)}
        onChange={e => set(path, e.target.value)}
        rows={3}
        style={{
          background: '#161B22', border: '1px solid rgba(255,255,255,.12)',
          borderRadius: 8, padding: '10px 14px', color: '#FAFAFA',
          fontSize: 13, width: '100%', boxSizing: 'border-box' as const,
          resize: 'vertical' as const, outline: 'none', fontFamily: 'inherit',
          lineHeight: 1.5
        }}
      />
    </div>
  )
}

function InsTituloTexto({ label, prefixPath, get, set }: {
  label: string; prefixPath: string;
  get: (p: string) => string; set: (p: string, v: string) => void;
}) {
  return (
    <div style={{ background: 'rgba(255,255,255,.02)', borderRadius: 8, padding: 14 }}>
      <label style={{ fontSize: 12, color: '#FAFAFA', fontWeight: 600, display: 'block', marginBottom: 8 }}>{label}</label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <label style={{ fontSize: 10, color: '#8B949E', display: 'block', marginBottom: 3 }}>Título</label>
          <input
            value={get(`${prefixPath}.titulo`)}
            onChange={e => set(`${prefixPath}.titulo`, e.target.value)}
            style={{
              background: '#161B22', border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 6, padding: '8px 12px', color: '#FAFAFA',
              fontSize: 13, width: '100%', boxSizing: 'border-box' as const, outline: 'none'
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 10, color: '#8B949E', display: 'block', marginBottom: 3 }}>Texto</label>
          <textarea
            value={get(`${prefixPath}.texto`)}
            onChange={e => set(`${prefixPath}.texto`, e.target.value)}
            rows={3}
            style={{
              background: '#161B22', border: '1px solid rgba(255,255,255,.12)',
              borderRadius: 6, padding: '10px 14px', color: '#FAFAFA',
              fontSize: 13, width: '100%', boxSizing: 'border-box' as const,
              resize: 'vertical' as const, outline: 'none', fontFamily: 'inherit',
              lineHeight: 1.5
            }}
          />
        </div>
      </div>
    </div>
  )
}

function InsKpi({ label, kpiKey, get, set }: {
  label: string; kpiKey: string;
  get: (p: string) => string; set: (p: string, v: string) => void;
}) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12, color: '#FAFAFA', fontWeight: 600, minWidth: 140, paddingTop: 10 }}>{label}</span>
      <input
        value={get(`kpis.${kpiKey}.delta`)}
        onChange={e => set(`kpis.${kpiKey}.delta`, e.target.value)}
        placeholder="Delta (ex: ▲ +12% vs 2024)"
        style={{
          background: '#161B22', border: '1px solid rgba(255,255,255,.12)',
          borderRadius: 6, padding: '8px 12px', color: '#FAFAFA',
          fontSize: 12, flex: '1 1 200px', outline: 'none', boxSizing: 'border-box' as const
        }}
      />
      <input
        value={get(`kpis.${kpiKey}.sub`)}
        onChange={e => set(`kpis.${kpiKey}.sub`, e.target.value)}
        placeholder="Sub-texto complementar"
        style={{
          background: '#161B22', border: '1px solid rgba(255,255,255,.12)',
          borderRadius: 6, padding: '8px 12px', color: '#FAFAFA',
          fontSize: 12, flex: '1 1 200px', outline: 'none', boxSizing: 'border-box' as const
        }}
      />
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
  },
  tabs: {
    display: 'flex', gap: 8, marginBottom: 20
  },
  tab: {
    background: 'rgba(255,255,255,.06)', border: '1px solid rgba(255,255,255,.08)',
    borderRadius: 8, padding: '10px 20px', color: '#8B949E',
    fontSize: 13, fontWeight: 600, cursor: 'pointer'
  },
  tabActive: {
    background: 'rgba(245,200,0,.12)', border: '1px solid rgba(245,200,0,.4)',
    borderRadius: 8, padding: '10px 20px', color: '#F5C800',
    fontSize: 13, fontWeight: 600, cursor: 'pointer'
  },
  actionBtn: {
    border: 'none', borderRadius: 6, padding: '5px 12px',
    fontSize: 11, fontWeight: 600, cursor: 'pointer'
  }
}
