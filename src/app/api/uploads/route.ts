import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json([], { status: 500 })
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  const { data, error } = await supabase
    .from('uploads')
    .select('id, filename, file_type, periodo, status, error_msg, uploaded_at, processed_at')
    .order('uploaded_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json([], { status: 500 })
  return NextResponse.json(data)
}
