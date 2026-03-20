import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  const { data, error } = await supabase
    .from('uploads')
    .select('id, filename, file_type, periodo, tipo_documento, status, error_msg, uploaded_at, processed_at')
    .order('uploaded_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json([], { status: 500 })
  return NextResponse.json(data)
}
