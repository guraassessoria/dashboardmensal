import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { tbl } from '@/lib/supabase'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  // Auto-cleanup: marcar como erro qualquer upload travado em 'processing' há mais de 10 minutos
  const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString()
  await supabase
    .from(tbl('uploads'))
    .update({ status: 'error', error_msg: 'Timeout: processamento excedeu 10 minutos' })
    .eq('status', 'processing')
    .lt('uploaded_at', cutoff)

  const { data, error } = await supabase
    .from(tbl('uploads'))
    .select('id, filename, file_type, periodo, tipo_documento, status, error_msg, uploaded_at, processed_at')
    .order('uploaded_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json([], { status: 500 })
  return NextResponse.json(data)
}
