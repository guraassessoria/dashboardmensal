import { NextRequest, NextResponse } from 'next/server'

const ADMIN_PWD = process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || 'cbf2025'

export async function POST(req: NextRequest) {
  const { password } = await req.json()
  
  if (password === ADMIN_PWD) {
    const res = NextResponse.json({ ok: true })
    // Cookie de sessão simples (24h)
    res.cookies.set('admin_auth', ADMIN_PWD, {
      httpOnly: true,
      secure: true,
      maxAge: 60 * 60 * 24,
      sameSite: 'strict'
    })
    return res
  }
  
  return NextResponse.json({ error: 'Senha incorreta' }, { status: 401 })
}
