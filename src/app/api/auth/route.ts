import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import bcrypt from 'bcryptjs'

const ADMIN_PWD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || 'cbf2025'
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'cbf_admin_token_2025'

export async function POST(req: NextRequest) {
  const body = await req.json()

  // Modo legado: senha fixa (mantém compatibilidade)
  if (body.password && !body.username) {
    if (body.password === ADMIN_PWD) {
      const res = NextResponse.json({ ok: true })
      res.cookies.set('admin_auth', AUTH_TOKEN, {
        httpOnly: true,
        secure: true,
        maxAge: 60 * 60 * 24,
        sameSite: 'strict'
      })
      return res
    }
    return NextResponse.json({ error: 'Senha incorreta' }, { status: 401 })
  }

  // Modo usuário: username + password
  const { username, password } = body
  if (!username || !password) {
    return NextResponse.json({ error: 'Usuário e senha são obrigatórios' }, { status: 400 })
  }

  const sb = supabaseAdmin()
  const { data: user, error } = await sb
    .from('dashboard_users')
    .select('id, username, password_hash, nome_completo, ativo, role')
    .eq('username', username.trim().toLowerCase())
    .single()

  if (error || !user) {
    return NextResponse.json({ error: 'Usuário ou senha incorretos' }, { status: 401 })
  }

  if (!user.ativo) {
    return NextResponse.json({ error: 'Usuário desativado' }, { status: 403 })
  }

  const match = await bcrypt.compare(password, user.password_hash)
  if (!match) {
    return NextResponse.json({ error: 'Usuário ou senha incorretos' }, { status: 401 })
  }

  const role = user.role || 'editor'
  if (role === 'consulta') {
    return NextResponse.json({ error: 'Sem permissão para acessar o painel admin' }, { status: 403 })
  }

  const res = NextResponse.json({
    ok: true,
    nome: user.nome_completo || user.username,
    role
  })
  res.cookies.set('admin_auth', AUTH_TOKEN, {
    httpOnly: true,
    secure: true,
    maxAge: 60 * 60 * 24,
    sameSite: 'strict'
  })
  return res
}
