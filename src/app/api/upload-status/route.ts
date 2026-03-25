import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tbl } from '@/lib/supabase'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'ID obrigatório' }, { status: 400 })

  const { data, error } = await supabase
    .from(tbl('uploads'))
    .select('status, error_msg, processed_at, uploaded_at')
    .eq('id', id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Auto-timeout: se está em processing por mais de 3 minutos, marcar como erro
  if (data.status === 'processing' && data.uploaded_at) {
    const elapsed = Date.now() - new Date(data.uploaded_at).getTime()
    if (elapsed > 3 * 60 * 1000) {
      await supabase
        .from(tbl('uploads'))
        .update({ status: 'error', error_msg: 'Timeout: processamento excedeu 3 minutos' })
        .eq('id', id)
      data.status = 'error'
      data.error_msg = 'Timeout: processamento excedeu 3 minutos'
    }
  }

  return NextResponse.json(data)
}
