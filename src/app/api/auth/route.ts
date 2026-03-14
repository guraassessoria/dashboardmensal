import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  const { password } = await req.json()
  
  if (password === process.env.ADMIN_PASSWORD) {
    const res = NextResponse.json({ ok: true })
    // Cookie de sessão simples (24h)
    res.cookies.set('admin_auth', process.env.ADMIN_PASSWORD!, {
      httpOnly: true,
      secure: true,
      maxAge: 60 * 60 * 24,
      sameSite: 'strict'
    })
    return res
  }
  
  return NextResponse.json({ error: 'Senha incorreta' }, { status: 401 })
}
