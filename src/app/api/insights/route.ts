import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tbl } from '@/lib/supabase'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/insights?periodo=2025-12
export async function GET(req: NextRequest) {
  const periodo = req.nextUrl.searchParams.get('periodo')

  if (periodo) {
    const { data, error } = await supabase
      .from(tbl('insights_gerados'))
      .select('*')
      .eq('periodo', periodo)
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    return NextResponse.json(data)
  }

  // Sem periodo: retorna lista de períodos disponíveis
  const { data, error } = await supabase
    .from(tbl('insights_gerados'))
    .select('periodo, updated_at')
    .order('periodo', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json(data)
}

// PUT /api/insights — atualiza conteúdo de insights
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'cbf_admin_token_2025'

export async function PUT(req: NextRequest) {
  const authCookie = req.cookies.get('admin_auth')
  if (!authCookie || authCookie.value !== AUTH_TOKEN) {
    return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
  }

  try {
    const { periodo, conteudo } = await req.json()

    if (!periodo || !conteudo) {
      return NextResponse.json({ error: 'periodo e conteudo são obrigatórios' }, { status: 400 })
    }

    const { error } = await supabase
      .from(tbl('insights_gerados'))
      .upsert({
        periodo,
        conteudo,
        updated_at: new Date().toISOString()
      }, { onConflict: 'periodo' })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, message: 'Insights atualizados com sucesso' })
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
