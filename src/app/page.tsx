// O dashboard.html em /public/ faz o fetch do Supabase diretamente no browser
// Esta rota redireciona para o arquivo estático correto conforme o ambiente
import { redirect } from 'next/navigation'

export default function Home() {
  const v = '20260325-01'
  redirect(`/dashboard.html?v=${v}`)
}
