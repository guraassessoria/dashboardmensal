import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// POST /api/migrate — executa migrações pendentes
export async function POST(req: NextRequest) {
  const authCookie = req.cookies.get('admin_auth')
  if (!authCookie || authCookie.value !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  const results: string[] = []

  try {
    // 1. Criar tabela dashboard_users (se não existir)
    const { error: e1 } = await supabase.rpc('exec_sql', {
      sql: `
        CREATE TABLE IF NOT EXISTS dashboard_users (
          id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          nome_completo TEXT,
          ativo BOOLEAN DEFAULT true,
          created_at TIMESTAMPTZ DEFAULT now(),
          updated_at TIMESTAMPTZ DEFAULT now()
        );
      `
    })
    if (e1) {
      // fallback: tenta via insert direto pra ver se tabela já existe
      const { error: checkErr } = await supabase
        .from('dashboard_users')
        .select('id')
        .limit(1)
      if (checkErr && checkErr.code === '42P01') {
        results.push('❌ dashboard_users: tabela precisa ser criada manualmente no SQL Editor')
      } else {
        results.push('✅ dashboard_users: tabela já existe')
      }
    } else {
      results.push('✅ dashboard_users: criada')
    }

    // 2. Verificar coluna tipo_documento em uploads
    const { error: e2 } = await supabase
      .from('uploads')
      .select('tipo_documento')
      .limit(1)
    if (e2 && e2.message?.includes('tipo_documento')) {
      results.push('❌ uploads.tipo_documento: coluna precisa ser adicionada manualmente')
    } else {
      results.push('✅ uploads.tipo_documento: coluna existe')
    }

    // 3. Verificar tabela insights_gerados
    const { error: e3 } = await supabase
      .from('insights_gerados')
      .select('id')
      .limit(1)
    if (e3 && e3.code === '42P01') {
      results.push('❌ insights_gerados: tabela precisa ser criada manualmente')
    } else {
      results.push('✅ insights_gerados: tabela existe')
    }

    // 4. Verificar configuração
    const { data: cfg } = await supabase
      .from('configuracao')
      .select('chave')
      .limit(5)
    results.push(`✅ configuracao: ${cfg?.length || 0} entradas`)

    return NextResponse.json({ ok: true, results })
  } catch (err: any) {
    return NextResponse.json({ error: err.message, results }, { status: 500 })
  }
}
