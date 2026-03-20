import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import bcrypt from 'bcryptjs'

// POST /api/login  — valida credenciais do dashboard
export async function POST(req: NextRequest) {
  const { username, password } = await req.json()

  if (!username || !password) {
    return NextResponse.json({ error: 'Credenciais inválidas' }, { status: 400 })
  }

  const sb = supabaseAdmin()
  const { data: user, error } = await sb
    .from('dashboard_users')
    .select('id, username, password_hash, nome_completo, ativo')
    .eq('username', username.trim().toLowerCase())
    .single()

  if (error || !user) {
    return NextResponse.json({ error: 'Usuário ou senha incorretos' }, { status: 401 })
  }

  if (!user.ativo) {
    return NextResponse.json({ error: 'Usuário desativado' }, { status: 403 })
  }

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    return NextResponse.json({ error: 'Usuário ou senha incorretos' }, { status: 401 })
  }

  return NextResponse.json({
    ok: true,
    nome: user.nome_completo || user.username
  })
}
