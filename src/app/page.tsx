// O dashboard.html em /public/ faz o fetch do Supabase diretamente no browser
// Esta rota redireciona para o arquivo estático correto conforme o ambiente
import { redirect } from 'next/navigation'

export default function Home() {
  const isDev =
    process.env.NEXT_PUBLIC_ENVIRONMENT === 'development' ||
    process.env.VERCEL_ENV === 'preview'
  redirect(isDev ? '/dashboard-dev.html' : '/dashboard.html')
}
