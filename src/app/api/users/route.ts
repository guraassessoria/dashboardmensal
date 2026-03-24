import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import bcrypt from 'bcryptjs'

const ADMIN_PWD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || 'cbf2025'

function isAdmin(req: NextRequest) {
  return req.cookies.get('admin_auth')?.value === ADMIN_PWD
}

// GET /api/users  — lista todos os usuários (sem expor password_hash)
export async function GET(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from('dashboard_users')
    .select('id, username, nome_completo, ativo, role, created_at, updated_at')
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// POST /api/users  — cria novo usuário
export async function POST(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const { username, password, nome_completo } = await req.json()

  if (!username || !password) {
    return NextResponse.json({ error: 'username e password são obrigatórios' }, { status: 400 })
  }

  const password_hash = await bcrypt.hash(password, 10)

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from('dashboard_users')
    .insert({ username: username.trim().toLowerCase(), password_hash, nome_completo: nome_completo || null })
    .select('id, username, nome_completo, ativo, role, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Usuário já existe' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}

// PUT /api/users  — atualiza usuário (senha, nome, ativo)
export async function PUT(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const { id, password, nome_completo, ativo, role } = await req.json()

  if (!id) {
    return NextResponse.json({ error: 'id é obrigatório' }, { status: 400 })
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (password) updates.password_hash = await bcrypt.hash(password, 10)
  if (nome_completo !== undefined) updates.nome_completo = nome_completo
  if (ativo !== undefined) updates.ativo = ativo
  if (role && ['admin', 'editor'].includes(role)) updates.role = role

  const sb = supabaseAdmin()
  const { data, error } = await sb
    .from('dashboard_users')
    .update(updates)
    .eq('id', id)
    .select('id, username, nome_completo, ativo, role, updated_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json(data)
}

// DELETE /api/users  — remove usuário
export async function DELETE(req: NextRequest) {
  if (!isAdmin(req)) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const { id } = await req.json()

  if (!id) {
    return NextResponse.json({ error: 'id é obrigatório' }, { status: 400 })
  }

  const sb = supabaseAdmin()
  const { error } = await sb
    .from('dashboard_users')
    .delete()
    .eq('id', id)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
